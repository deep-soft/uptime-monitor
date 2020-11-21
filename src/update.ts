import { Octokit } from "@octokit/rest";
import slugify from "@sindresorhus/slugify";
import { mkdirp, readFile, writeFile } from "fs-extra";
import { safeLoad } from "js-yaml";
import { join } from "path";
import { commit, lastCommit, push } from "./helpers/git";
import { shouldContinue } from "./helpers/init-check";
import { UpptimeConfig } from "./interfaces";
import { sendNotification } from "./helpers/notifications";
import { generateSummary } from "./summary";
import { curl } from "./helpers/request";

export const update = async (shouldCommit = false) => {
  if (!(await shouldContinue())) return;
  await mkdirp("history");
  const config = safeLoad(await readFile(join(".", ".upptimerc.yml"), "utf8")) as UpptimeConfig;
  let [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");

  const octokit = new Octokit({
    auth: config.PAT || process.env.GH_PAT || process.env.GITHUB_TOKEN,
    userAgent: config["user-agent"] || process.env.USER_AGENT || "KojBot",
  });

  let hasDelta = false;
  for await (const site of config.sites) {
    const slug = site.slug || slugify(site.name);
    console.log("Checking", site.url);
    let currentStatus = "unknown";
    let startTime = new Date().toISOString();

    try {
      currentStatus =
        (
          (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
            .split("\n")
            .find((line) => line.toLocaleLowerCase().includes("- status")) || ""
        )
          .split(":")[1]
          .trim() || "unknown";
      startTime =
        (
          (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
            .split("\n")
            .find((line) => line.toLocaleLowerCase().includes("- starttime")) || ""
        )
          .split("startTime:")[1]
          .trim() || new Date().toISOString();
    } catch (error) {}

    const performTestOnce = async () => {
      const result = await curl(site);
      console.log("Result", result);
      const responseTime = (result.totalTime * 1000).toFixed(0);
      const expectedStatusCodes = (
        site.expectedStatusCodes || [
          200,
          201,
          202,
          203,
          200,
          204,
          205,
          206,
          207,
          208,
          226,
          300,
          301,
          302,
          303,
          304,
          305,
          306,
          307,
          308,
        ]
      ).map(Number);
      console.log("Expected status codes", expectedStatusCodes);
      const status: "up" | "down" = expectedStatusCodes.includes(Number(result.httpCode))
        ? "up"
        : "down";
      return { result, responseTime, status };
    };

    let { result, responseTime, status } = await performTestOnce();
    /**
     * If the site is down, we perform the test 2 more times to make
     * sure that it's not a false alarm
     */
    if (status === "down") {
      wait(1000);
      const secondTry = await performTestOnce();
      if (secondTry.status === "up") {
        result = secondTry.result;
        responseTime = secondTry.responseTime;
        status = secondTry.status;
      } else {
        wait(10000);
        const thirdTry = await performTestOnce();
        if (thirdTry.status === "up") {
          result = thirdTry.result;
          responseTime = thirdTry.responseTime;
          status = thirdTry.status;
        }
      }
    }

    try {
      if (shouldCommit || currentStatus !== status) {
        const content = `- url: ${site.url}
- status: ${status}
- code: ${result.httpCode}
- responseTime: ${responseTime}
- lastUpdated: ${new Date().toISOString()}
- startTime: ${startTime}
- generator: Upptime <https://github.com/upptime/upptime>
`;

        await writeFile(join(".", "history", `${slug}.yml`), content);
        commit(
          (
            (config.commitMessages || {}).statusChange ||
            "$EMOJI $SITE_NAME is $STATUS ($RESPONSE_CODE in $RESPONSE_TIME ms) [skip ci] [upptime]"
          )
            .replace("$EMOJI", status === "up" ? "🟩" : "🟥")
            .replace("$SITE_NAME", site.name)
            .replace("$SITE_URL", site.url)
            .replace("$SITE_METHOD", site.method || "GET")
            .replace("$STATUS", status)
            .replace("$RESPONSE_CODE", result.httpCode.toString())
            .replace("$RESPONSE_TIME", responseTime),
          (config.commitMessages || {}).commitAuthorName,
          (config.commitMessages || {}).commitAuthorEmail
        );
        const lastCommitSha = lastCommit();

        if (currentStatus !== status) {
          console.log("Status is different", currentStatus, "to", status);
          hasDelta = true;

          const issues = await octokit.issues.list({
            owner,
            repo,
            labels: slug,
            filter: "all",
            state: "open",
            sort: "created",
            direction: "desc",
            per_page: 1,
          });
          console.log(`Found ${issues.data.length} issues`);

          // If the site was just recorded as down, open an issue
          if (status === "down") {
            if (!issues.data.length) {
              const newIssue = await octokit.issues.create({
                owner,
                repo,
                title: `🛑 ${site.name} is down`,
                body: `In [\`${lastCommitSha.substr(
                  0,
                  7
                )}\`](https://github.com/${owner}/${repo}/commit/${lastCommitSha}), ${site.name} (${
                  site.url
                }) was **down**:
- HTTP code: ${result.httpCode}
- Response time: ${responseTime} ms
`,
                assignees: [...(config.assignees || []), ...(site.assignees || [])],
                labels: ["status", slug],
              });
              await octokit.issues.lock({
                owner,
                repo,
                issue_number: newIssue.data.number,
              });
              console.log("Opened and locked a new issue");
              await sendNotification(
                config,
                `🟥 ${site.name} (${site.url}) is **down**: ${newIssue.data.html_url}`
              );
            } else {
              console.log("An issue is already open for this");
            }
          } else if (issues.data.length) {
            // If the site just came back up
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number: issues.data[0].number,
              body: `**Resolved:** ${site.name} is back up in [\`${lastCommitSha.substr(
                0,
                7
              )}\`](https://github.com/${owner}/${repo}/commit/${lastCommitSha}).`,
            });
            console.log("Created comment in issue");
            await octokit.issues.update({
              owner,
              repo,
              issue_number: issues.data[0].number,
              state: "closed",
            });
            console.log("Closed issue");
            await sendNotification(config, `🟩 ${site.name} (${site.url}) is back up.`);
          } else {
            console.log("Could not find a relevant issue", issues.data);
          }
        } else {
          console.log("Status is the same", currentStatus, status);
        }
      } else {
        console.log("Skipping commit, ", "status is", status);
      }
    } catch (error) {
      console.log("ERROR", error);
    }
  }
  push();

  if (!config.skipDeleteIssues) {
    // Find all the opened issues that shouldn't have opened
    // Say, Upptime found a down monitor and it was back up within 5 min
    const issuesRecentlyClosed = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "closed",
      labels: "status",
      per_page: 10,
    });
    console.log("Found recently closed issues", issuesRecentlyClosed.data.length);
    for await (const issue of issuesRecentlyClosed.data) {
      if (
        // If this issue was closed within 15 minutes
        new Date(issue.closed_at).getTime() - new Date(issue.created_at).getTime() < 900000 &&
        // It has 1 comment (the default Upptime one)
        issue.comments === 1
      ) {
        try {
          console.log("Trying to delete issue", issue.number, issue.node_id);
          const result = await octokit.graphql(`
      mutation deleteIssue {
        deleteIssue(input:{issueId:"${issue.node_id}"}) {
          clientMutationId
        }
      }`);
          console.log("Success", result);
        } catch (error) {
          console.log("Error deleting this issue", error);
        }
      }
    }
  }

  if (hasDelta) generateSummary();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

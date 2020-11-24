"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSummary = void 0;
const slugify_1 = __importDefault(require("@sindresorhus/slugify"));
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const prettier_1 = require("prettier");
const calculate_uptime_1 = require("./helpers/calculate-uptime");
const config_1 = require("./helpers/config");
const git_1 = require("./helpers/git");
const github_1 = require("./helpers/github");
const init_check_1 = require("./helpers/init-check");
const generateSummary = async () => {
    if (!(await init_check_1.shouldContinue()))
        return;
    await fs_extra_1.mkdirp("history");
    let [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
    const config = await config_1.getConfig();
    const octokit = await github_1.getOctokit();
    let readmeContent = await fs_extra_1.readFile(path_1.join(".", "README.md"), "utf8");
    const startText = readmeContent.split(config.summaryStartHtmlComment || "<!--start: status pages-->")[0];
    const endText = readmeContent.split(config.summaryEndHtmlComment || "<!--end: status pages-->")[1];
    // This object will track the summary data of all sites
    const pageStatuses = [];
    // We'll keep incrementing this if there are down/degraded sites
    // This is used to show the overall status later
    let numberOfDown = 0;
    let numberOfDegraded = 0;
    // Loop through each site and add compute the current status
    for await (const site of config.sites) {
        const slug = site.slug || slugify_1.default(site.name);
        // Get the git history for this site
        const history = await octokit.repos.listCommits({
            owner,
            repo,
            path: `history/${slug}.yml`,
            per_page: 100,
        });
        if (!history.data.length)
            continue;
        // Calculate the average response time by taking data from commits
        const averageTime = history.data
            .filter((item) => item.commit.message.includes(" in ") &&
            Number(item.commit.message.split(" in ")[1].split("ms")[0].trim()) !== 0 &&
            !isNaN(Number(item.commit.message.split(" in ")[1].split("ms")[0].trim())))
            /**
             * Parse the commit message
             * @example "🟥 Broken Site is down (500 in 321 ms) [skip ci] [upptime]"
             * @returns 321
             */
            .map((item) => Number(item.commit.message.split(" in ")[1].split("ms")[0].trim()))
            .filter((item) => item && !isNaN(item))
            .reduce((p, c) => p + c, 0) / history.data.length;
        // Current status is "up", "down", or "degraded" based on the emoji prefix of the commit message
        const status = history.data[0].commit.message
            .split(" ")[0]
            .includes(config.commitPrefixStatusUp || "🟩")
            ? "up"
            : history.data[0].commit.message
                .split(" ")[0]
                .includes(config.commitPrefixStatusDegraded || "🟨")
                ? "degraded"
                : "down";
        pageStatuses.push({
            name: site.name,
            url: site.url,
            slug,
            status,
            uptime: await calculate_uptime_1.getUptimePercentForSite(slug),
            time: Math.floor(averageTime),
        });
        if (status === "down")
            numberOfDown++;
        if (status === "degraded")
            numberOfDegraded++;
    }
    let website = `https://${config.owner}.github.io/${config.repo}`;
    if (config["status-website"] && config["status-website"].cname)
        website = `https://${config["status-website"].cname}`;
    const i18n = config.i18n || {};
    if (readmeContent.includes(config.summaryStartHtmlComment || "<!--start: status pages-->")) {
        readmeContent = `${startText}${config.summaryStartHtmlComment || "<!--start: status pages-->"}
<!-- This summary is generated by Upptime (https://github.com/upptime/upptime) -->
<!-- Do not edit this manually, your changes will be overwritten -->
| ${i18n.url || "URL"} | ${i18n.status || "Status"} | ${i18n.history || "History"} | ${i18n.responseTime || "Response Time"} | ${i18n.uptime || "Uptime"} |
| --- | ------ | ------- | ------------- | ------ |
${pageStatuses
            .map((page) => `| ${page.url.includes("$") ? page.name : `[${page.name}](${page.url})`} | ${page.status === "up"
            ? i18n.up || "🟩 Up"
            : page.status === "degraded"
                ? i18n.degraded || "🟨 Degraded"
                : i18n.down || "🟥 Down"} | [${page.slug}.yml](https://github.com/${owner}/${repo}/commits/master/history/${page.slug}.yml) | <img alt="${i18n.responseTimeGraphAlt || "Response time graph"}" src="./graphs/${page.slug}.png" height="20"> ${page.time}${i18n.ms || "ms"} | [![${i18n.uptime || "Uptime"} ${page.uptime}](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F${owner}%2F${repo}%2Fmaster%2Fapi%2F${page.slug}%2Fuptime.json)](${website}/history/${page.slug})`)
            .join("\n")}
${config.summaryEndHtmlComment || "<!--end: status pages-->"}${endText}`;
    }
    // Skip running this in the template repository
    if (`${owner}/${repo}` !== "upptime/upptime") {
        // Remove Upptime logo and add heaading
        readmeContent = readmeContent
            .split("\n")
            .map((line, index) => {
            if (index === 0 && line.includes("https://upptime.js.org"))
                return `# [📈 ${i18n.liveStatus || "Live Status"}](${website}): ${i18n.liveStatusHtmlComment || "<!--live status-->"} **${i18n.allSystemsOperational || "🟩 All systems operational"}**`;
            if (line.includes("[![Summary CI](https://github.com") &&
                readmeContent.includes("<!--start: description-->"))
                return `${line}\n\nWith [Upptime](https://upptime.js.org), you can get your own unlimited and free uptime monitor and status page, powered entirely by a GitHub repository. We use [Issues](https://github.com/${config.owner}/${config.repo}/issues) as incident reports, [Actions](https://github.com/${config.owner}/${config.repo}/actions) as uptime monitors, and [Pages](${website}) for the status page.`;
            return line;
        })
            .filter((line) => !line.startsWith(`## [📈 ${i18n.liveStatus || "Live Status"}]`))
            .join("\n");
        // Remove default documentation
        const docsStartText = readmeContent.split("<!--start: docs-->")[0];
        const docsEndText = readmeContent.split("<!--end: docs-->")[1];
        if (readmeContent.includes("<!--start: docs-->"))
            readmeContent = `${docsStartText}[**Visit our status website →**](${website})${docsEndText}`;
        // Remove Koj logo
        const logoStartText = readmeContent.split("<!--start: logo-->")[0];
        const logoEndText = readmeContent.split("<!--end: logo-->")[1];
        if (readmeContent.includes("<!--start: logo-->"))
            readmeContent = `${logoStartText}${logoEndText}`;
        let name = `[${config.owner}](${website})`;
        if (readmeContent.includes("[MIT](./LICENSE) © [Koj](https://koj.co)") ||
            readmeContent.includes("<!--start: description-->")) {
            try {
                const org = await octokit.users.getByUsername({ username: config.owner });
                name = `[${org.data.name || config.owner}](${org.data.blog || website})`;
            }
            catch (error) { }
            // Remove Koj description
            const descriptionStartText = readmeContent.split("<!--start: description-->")[0];
            const descriptionEndText = readmeContent.split("<!--end: description-->")[1];
            if (readmeContent.includes("<!--start: description-->"))
                readmeContent = `${descriptionStartText}This repository contains the open-source uptime monitor and status page for ${name}, powered by [Upptime](https://github.com/upptime/upptime).${descriptionEndText}`;
            // Change copyright
            readmeContent = readmeContent.replace("[MIT](./LICENSE) © [Koj](https://koj.co)", `[MIT](./LICENSE) © ${name}`);
            // Add powered by Upptime
            if (!config.skipPoweredByReadme) {
                readmeContent = readmeContent.replace("## 📄 License\n\n- Code: [MIT](./LICENSE)", "## 📄 License\n\n- Powered by: [Upptime](https://github.com/upptime/upptime)\n- Code: [MIT](./LICENSE)");
            }
        }
        // Change badges
        readmeContent = readmeContent.replace(new RegExp("upptime/upptime/workflows", "g"), `${config.owner}/${config.repo}/workflows`);
        // Add repo description, topics, etc.
        try {
            const repoInfo = await octokit.repos.get({ owner, repo });
            if (!repoInfo.data.description && !config.skipDescriptionUpdate)
                await octokit.repos.update({
                    owner,
                    repo,
                    description: `📈 Uptime monitor and status page for ${name
                        .split("]")[0]
                        .replace("[", "")}, powered by @upptime`,
                });
            console.log("Current topics are", repoInfo.data.topics);
            if (!(repoInfo.data.topics || []).includes("upptime") && !config.skipTopicsUpdate)
                await octokit.repos.replaceAllTopics({
                    owner,
                    repo,
                    names: [
                        ...(repoInfo.data.topics || []),
                        "uptime-monitor",
                        "status-page",
                        "upptime",
                    ].filter((value, index, array) => array.indexOf(value) === index),
                });
            console.log("Possibly updated to to", [...(repoInfo.data.topics || []), "uptime-monitor", "status-page", "upptime"].filter((value, index, array) => array.indexOf(value) === index));
            console.log("Topics are", (await octokit.repos.get({ owner, repo })).data.topics);
            if (!repoInfo.data.homepage && !config.skipHomepageUpdate)
                await octokit.repos.update({
                    owner,
                    repo,
                    homepage: website,
                });
        }
        catch (error) {
            console.log(error);
        }
    }
    // Add live status line
    readmeContent = readmeContent
        .split("\n")
        .map((line) => {
        if (line.includes("<!--live status-->")) {
            line = `${line.split("<!--live status-->")[0]}<!--live status--> **${numberOfDown === 0
                ? numberOfDegraded === 0
                    ? i18n.allSystemsOperational || "🟩 All systems operational"
                    : i18n.degradedPerformance || "🟨 Degraded performance"
                : numberOfDown === config.sites.length
                    ? i18n.completeOutage || "🟥 Complete outage"
                    : i18n.partialOutage || "🟧 Partial outage"}**`;
        }
        return line;
    })
        .join("\n");
    await fs_extra_1.writeFile(path_1.join(".", "README.md"), prettier_1.format(readmeContent, { parser: "markdown" }));
    git_1.commit((config.commitMessages || {}).readmeContent ||
        ":pencil: Update summary in README [skip ci] [upptime]", (config.commitMessages || {}).commitAuthorName, (config.commitMessages || {}).commitAuthorEmail);
    await fs_extra_1.writeFile(path_1.join(".", "history", "summary.json"), JSON.stringify(pageStatuses, null, 2));
    git_1.commit((config.commitMessages || {}).summaryJson ||
        ":card_file_box: Update status summary [skip ci] [upptime]", (config.commitMessages || {}).commitAuthorName, (config.commitMessages || {}).commitAuthorEmail);
    git_1.push();
};
exports.generateSummary = generateSummary;
//# sourceMappingURL=summary.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSite = void 0;
const shelljs_1 = require("shelljs");
const init_check_1 = require("./init-check");
const generateSite = async () => {
    if (!(await init_check_1.shouldContinue()))
        return;
    const siteDir = "site";
    shelljs_1.mkdir(siteDir);
    shelljs_1.cd(siteDir);
    shelljs_1.exec("npm init -y");
    shelljs_1.exec("npm i @upptime/status-page");
    shelljs_1.cp("-r", "node_modules/@upptime/status-page/*", ".");
    shelljs_1.exec("npm i");
    shelljs_1.exec("npm run export");
    shelljs_1.mkdir("-p", "status-page/__sapper__/export");
    shelljs_1.cp("-r", "__sapper__/export/*", "status-page/__sapper__/export");
    shelljs_1.cd("../..");
};
exports.generateSite = generateSite;
//# sourceMappingURL=site.js.map
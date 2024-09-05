module.exports = (() => {
  const obsidian = require("obsidian");
  const { Plugin, Notice } = obsidian;
  const path = require("node:path");
  const util = require("node:util");

  const child_process = require("node:child_process");
  const execFile = util.promisify(child_process.execFile);

  class GitBackupPlugin extends Plugin {
    onload() {
      console.log("Git Backup plugin loaded");

      const item = this.addStatusBarItem();
      obsidian.setIcon(item, "git-branch");
      item.createEl("span", { text: " No changes" });

      this.addCommand({
        id: "git-backup",
        name: "Backup",
        callback: () => {
          console.log("Creating Git backup");

          this.gitSync()
            .then(() => {
              new Notice("Git backup complete");
            })
            .catch((error) => {
              new Notice(`Error creating Git backup: ${error}`);
            });
        },
      });
    }

    unload() {
      console.log("Git Backup plugin unloaded");
    }

    async gitSync() {
      const shellEnv = await getShellEnv();
      console.log("shell env", shellEnv);

      const git = await whichGit(shellEnv);
      console.log("git path", git);

      const dataAdapter = this.app.vault.adapter;
      assert(
        dataAdapter instanceof obsidian.FileSystemAdapter,
        "dataAdapter is FileSystemAdapter",
      );

      const gitWorkTree = dataAdapter.getBasePath();
      const gitDir = path.join(gitWorkTree, ".git");

      await gitFetch(git, gitDir, "origin", "main");

      const commitMessage = `vault backup: ${getTimestamp()}`;
      await gitCommitAll(
        git,
        gitDir,
        path.join(gitDir, "index"),
        gitWorkTree,
        shellEnv,
        commitMessage,
      );

      await gitPush(git, gitDir, "origin", "main");
    }
  }

  /**
   * Get user's login shell environment variables.
   *
   * @returns {Promise<Record<string, string>>}
   */
  async function getShellEnv() {
    const shell = process.env.SHELL;
    assert(shell, "SHELL environment variable is set");
    const { stdout } = await execFile(shell, ["-l", "-c", "env"], {
      env: process.env,
    });
    /** @type {Record<string, string>} */
    const env = {};
    for (const line of stdout.split("\n")) {
      const [key, value] = line.split("=", 2);
      if (key) env[key] = value;
    }
    return env;
  }

  /**
   * Get the path to the git binary.
   * @param {Record<string, string>} env
   * @returns {Promise<string>}
   */
  async function whichGit(env) {
    const { stdout } = await execFile("which", ["git"], { env });
    return stdout.trim();
  }

  /**
   * Run `git fetch` in the given git directory.
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} repository
   * @param {string} refspec
   * @returns {Promise<void>}
   */
  async function gitFetch(gitBinPath, gitDir, repository, refspec) {
    const env = { GIT_DIR: gitDir };
    const { stderr } = await execFile(
      gitBinPath,
      ["fetch", repository, refspec],
      { env },
    );
    console.log("git fetch:", stderr);
  }

  /**
   * Run `git push` in the given git directory.
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} repository
   * @param {string} refspec
   * @returns {Promise<void>}
   */
  async function gitPush(gitBinPath, gitDir, repository, refspec) {
    const env = { GIT_DIR: gitDir };
    const { stderr } = await execFile(
      gitBinPath,
      ["push", repository, refspec],
      { env },
    );
    console.log("git push:", stderr);
  }

  /**
   * Run `git commit` in the given git directory.
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} gitIndexFile
   * @param {string} gitWorkTree
   * @param {Record<string, string>} commitEnv
   * @param {string} commitMessage
   * @returns {Promise<string>}
   */
  async function gitCommitAll(
    gitBinPath,
    gitDir,
    gitIndexFile,
    gitWorkTree,
    commitEnv,
    commitMessage,
  ) {
    const env = {
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: gitIndexFile,
      GIT_WORK_TREE: gitWorkTree,
    };
    await execFile(gitBinPath, ["reset", "--mixed"], { env: env });
    await execFile(gitBinPath, ["add", "."], { env: env });
    await execFile(gitBinPath, ["commit", "--message", commitMessage], {
      env: { ...commitEnv, ...env },
    });
    const { stdout } = await execFile(gitBinPath, ["rev-parse", "HEAD"], {
      env: env,
    });
    // TODO:
    //   rm "$GIT_DIR/ORIG_HEAD"
    //   rm "$GIT_DIR/COMMIT_EDITMSG"
    //   rm "$GIT_INDEX_FILE"
    console.log("git commit:", stdout.trim());
    return stdout.trim();
  }

  /**
   * Get a timestamp in the format "YYYY-MM-DD HH:mm:ss".
   * $ date +"%Y-%m-%d %H:%M:%S"
   *
   * @returns {string}
   */
  function getTimestamp() {
    const now = new Date();
    return now
      .toLocaleString("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      .replace(/(\d+)\/(\d+)\/(\d+),/, "$3-$1-$2");
  }

  /**
   * @param {any} value
   * @param {string} message
   * @returns {asserts value}
   */
  function assert(value, message) {
    console.assert(value, message);
  }

  return GitBackupPlugin;
})();

module.exports = (() => {
  const obsidian = require("obsidian");
  const { Plugin, Notice } = obsidian;

  const child_process = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const util = require("node:util");

  const execFile = util.promisify(child_process.execFile);
  const unlink = util.promisify(fs.unlink);

  class GitBackupPlugin extends Plugin {
    onload() {
      console.log("Git Backup plugin loaded");

      const item = this.addStatusBarItem();
      obsidian.setIcon(item, "git-branch");
      item.createEl("span", { text: "No changes" });

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

    /**
     * Load data with defaults.
     * @returns {Promise<{
     *   gitBinPath: string,
     *   gitDir: string,
     *   gitRemoteName: string,
     *   gitRemoteURL: string,
     *   gitBranchName: string,
     *   gitBinPath: string,
     *   gitUserName: string,
     *   gitUserEmail: string,
     * }>}
     */
    async loadDataWithDefaults() {
      let data = {
        gitBinPath: "/usr/bin/git",
        gitDir: "",
        gitRemoteName: "origin",
        gitRemoteURL: "",
        gitBranchName: "main",
        gitUserName: "",
        gitUserEmail: "",
      };

      const localData = await this.loadData();
      if (localData !== undefined) {
        data = { ...data, ...localData };
      }

      if (data.gitDir === "") {
        const dataAdapter = this.app.vault.adapter;
        assert(
          dataAdapter instanceof obsidian.FileSystemAdapter,
          "dataAdapter is FileSystemAdapter",
        );

        data.gitDir = path.join(dataAdapter.getBasePath(), ".git");
      }

      const shellEnv = await getShellEnv();
      const gitBinPath = await whichGit(shellEnv);
      if (gitBinPath) {
        data.gitBinPath = gitBinPath;
      }

      if (data.gitUserName === "") {
        data.gitUserName = await getGitConfig("user.name", shellEnv);
      }
      if (data.gitUserEmail === "") {
        data.gitUserEmail = await getGitConfig("user.email", shellEnv);
      }

      console.log("git-backup data", data);

      return data;
    }

    async gitSync() {
      const data = await this.loadDataWithDefaults();
      const {
        gitBinPath,
        gitDir,
        gitRemoteName,
        gitBranchName,
        gitUserName,
        gitUserEmail,
      } = data;

      const dataAdapter = this.app.vault.adapter;
      assert(
        dataAdapter instanceof obsidian.FileSystemAdapter,
        "dataAdapter is FileSystemAdapter",
      );
      const gitWorkTree = dataAdapter.getBasePath();

      await gitFetch(gitBinPath, gitDir, gitRemoteName, gitBranchName);

      const commitMessage = `vault backup: ${getTimestamp()}`;
      await gitCommitAll(
        gitBinPath,
        gitDir,
        gitWorkTree,
        commitMessage,
        gitUserName,
        gitUserEmail,
      );

      await gitPush(gitBinPath, gitDir, gitRemoteName, gitBranchName);
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
   *
   * @param {Record<string, string>} env
   * @returns {Promise<string>}
   */
  async function whichGit(env) {
    const { stdout } = await execFile("which", ["git"], { env });
    return stdout.trim();
  }

  /**
   * Get git config global value.
   *
   * @param {string} name
   * @param {Record<string, string>} env
   * @returns {Promise<string>}
   */
  async function getGitConfig(name, env) {
    const { stdout } = await execFile(
      "git",
      ["config", "--global", "get", name],
      {
        env,
      },
    );
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
   * @param {string} gitWorkTree
   * @param {string} commitMessage
   * @param {string} gitUserName
   * @param {string} gitUserEmail
   * @returns {Promise<string>}
   */
  async function gitCommitAll(
    gitBinPath,
    gitDir,
    gitWorkTree,
    commitMessage,
    gitUserName,
    gitUserEmail,
  ) {
    const randSuffix = Math.random().toString(36).substring(2, 15);
    const indexFile = path.join(gitDir, `index.${randSuffix}`);

    const env = {
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: indexFile,
      GIT_WORK_TREE: gitWorkTree,
      GIT_AUTHOR_NAME: gitUserName,
      GIT_AUTHOR_EMAIL: gitUserEmail,
      GIT_COMMITTER_NAME: gitUserName,
      GIT_COMMITTER_EMAIL: gitUserEmail,
    };

    await execFile(gitBinPath, ["add", "."], {
      env: env,
    });

    await execFile(gitBinPath, ["commit", "--message", commitMessage], {
      env: env,
    });

    await unlink(path.join(gitDir, "COMMIT_EDITMSG"));
    await unlink(indexFile);

    const { stdout } = await execFile(gitBinPath, ["rev-parse", "HEAD"], {
      env: env,
    });
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

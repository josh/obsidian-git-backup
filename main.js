module.exports = (() => {
  const obsidian = require("obsidian");
  const { Plugin, Notice } = obsidian;

  const child_process = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const util = require("node:util");

  const { access, unlink } = require("node:fs/promises");
  const execFile = util.promisify(child_process.execFile);

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
              console.error(error);
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
        gitRemoteURL: "",
        gitBranchName: "main",
        gitUserName: "",
        gitUserEmail: "",
      };

      const localData = await this.loadData();
      if (localData !== undefined) {
        data = { ...data, ...localData };
      }

      const shellEnv = await getShellEnv();
      const gitBinPath = await whichGit(shellEnv);
      if (gitBinPath) {
        data.gitBinPath = gitBinPath;
      }

      if (data.gitUserName === "") {
        data.gitUserName = await getGitGlobalConfig(
          data.gitBinPath,
          "user.name",
          shellEnv,
        );
      }
      if (data.gitUserEmail === "") {
        data.gitUserEmail = await getGitGlobalConfig(
          data.gitBinPath,
          "user.email",
          shellEnv,
        );
      }

      console.log("git-backup data", data);

      return data;
    }

    async gitSync() {
      const data = await this.loadDataWithDefaults();
      const {
        gitBinPath,
        gitRemoteURL,
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

      const vaultName = this.app.vault.getName();
      const cacheGitDir = path.join(getCacheDir(), `${vaultName}.git`);

      assert(gitRemoteURL, "gitRemoteURL isn't set");
      await gitFetch(gitBinPath, cacheGitDir, gitRemoteURL);

      const commitMessage = `vault backup: ${getTimestamp()}`;
      await gitCommitAll(
        gitBinPath,
        cacheGitDir,
        gitWorkTree,
        commitMessage,
        gitUserName,
        gitUserEmail,
      );
      await gitPush(gitBinPath, cacheGitDir, "origin", gitBranchName);
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
   * @param {string} gitBinPath
   * @param {string} name
   * @param {Record<string, string>} shellEnv
   * @returns {Promise<string>}
   */
  async function getGitGlobalConfig(gitBinPath, name, shellEnv) {
    const git = execEnv.bind(null, gitBinPath, shellEnv);
    const { stdout } = await git(["config", "--global", name]);
    return stdout.trim();
  }

  /**
   * Fetch or clone a git repository.
   *
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} url
   * @returns {Promise<void>}
   */
  async function gitFetch(gitBinPath, gitDir, url) {
    const env = { GIT_DIR: gitDir };
    const git = execEnv.bind(null, gitBinPath, env);

    if (await exists(gitDir)) {
      const { stdout } = await git(["config", "--local", "remote.origin.url"]);
      assert(stdout.trim() === url, "Unexpected remote URL");

      const { stderr } = await git(["fetch", "origin"]);
      console.log("git fetch:", stderr);
    } else {
      console.log("git cloning", url);
      await git(["clone", "--bare", url, gitDir]);
    }
  }

  /**
   * Push local git changes to remote.
   *
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} repository
   * @param {string} refspec
   * @returns {Promise<void>}
   */
  async function gitPush(gitBinPath, gitDir, repository, refspec) {
    const env = { GIT_DIR: gitDir };
    const git = execEnv.bind(null, gitBinPath, env);
    const { stderr } = await git(["push", repository, refspec]);
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
   * @returns {Promise<string | null>}
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
    const git = execEnv.bind(null, gitBinPath, env);

    try {
      // I don't think I need to reset the index if I'm using a temp file
      // await git(["reset", "--mixed", "HEAD"]);

      await git(["add", "."]);

      let hasChanges;
      try {
        await git(["diff", "--staged", "--quiet"]);
        hasChanges = false;
      } catch (error) {
        hasChanges = true;
      }

      if (hasChanges) {
        await git(["commit", "--message", commitMessage]);
        const { stdout } = await git(["rev-parse", "HEAD"]);
        console.log("git commit:", stdout.trim());
        return stdout.trim();
      } else {
        console.log("git commit: no changes");
        return null;
      }
    } finally {
      await unlinkForce(path.join(gitDir, "COMMIT_EDITMSG"));
      await unlinkForce(indexFile);
    }
  }

  /**
   * Run command with given environment and arguments.
   *
   * @param {string} file
   * @param {Record<string, string>} env
   * @param {string[]} args
   * @returns {Promise<{ stdout: string; stderr: string }>}
   */
  async function execEnv(file, env, args) {
    return await execFile(file, args, { env });
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
   * Get platform cache directory.
   *
   * macOS: `$HOME/Library/Caches/obsidian-git-backup`
   * Linux: `$XDG_CACHE_HOME/obsidian-git-backup` or
   *        `$HOME/.cache/obsidian-git-backup`
   * Windows: `%LOCALAPPDATA%\obsidian-git-backup\Cache`
   */
  function getCacheDir() {
    const platform = process.platform;
    const home = os.homedir();
    assert(home, "HOME is not set");

    if (platform === "darwin") {
      return path.join(home, "Library", "Caches", "obsidian-git-backup");
    } else if (platform === "linux") {
      const cacheHome = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
      return path.join(cacheHome, "obsidian-git-backup");
    } else if (platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA;
      assert(localAppData, "LOCALAPPDATA is not set");
      return path.join(localAppData, "obsidian-git-backup", "Cache");
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Check if a file or directory exists.
   *
   * @param {fs.PathLike} path
   * @returns {Promise<boolean>}
   */
  async function exists(path) {
    try {
      await access(path, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Unlink file or ignore if it doesn't exist.
   * Basically `rm -f`.
   *
   * @param {fs.PathLike} path
   * @returns {Promise<void>}
   */
  async function unlinkForce(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
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

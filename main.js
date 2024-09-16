module.exports = (() => {
  const obsidian = require("obsidian");
  const { Plugin, PluginSettingTab, Setting, Notice } = obsidian;

  const child_process = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const util = require("node:util");

  const { access, unlink } = require("node:fs/promises");
  const execFile = util.promisify(child_process.execFile);

  const DEFAULT_SETTINGS = Object.freeze({
    gitRemoteURL: "",
    gitBranchName: "main",
    gitUserName: "",
    gitUserEmail: "",
  });

  class GitBackupPlugin extends Plugin {
    /**
     * @type {{
     *   gitRemoteURL: string,
     *   gitBranchName: string,
     *   gitUserName: string,
     *   gitUserEmail: string
     * }}
     */
    settings = DEFAULT_SETTINGS;

    /** @type {string | null} */
    gitBinPath = null;

    /** @type {HTMLElement | null} */
    statusBarItem = null;

    /** @type {boolean} */
    statusBarUpdateLock = false;

    async onload() {
      this.gitBinPath = await detectGit();
      if (this.gitBinPath === null) {
        console.warn("Failed to load git-backup plugin, git not found");
        return;
      }
      console.log("Using git", this.gitBinPath);

      await this.loadSettings();
      this.addSettingTab(new GitBackupSettingTab(this.app, this));

      this.initStatusBarItem();
      this.enqueueUpdateStatusBar();
      this.registerEvent(
        this.app.vault.on("create", this.enqueueUpdateStatusBar.bind(this)),
      );
      this.registerEvent(
        this.app.vault.on("modify", this.enqueueUpdateStatusBar.bind(this)),
      );
      this.registerEvent(
        this.app.vault.on("delete", this.enqueueUpdateStatusBar.bind(this)),
      );
      this.registerEvent(
        this.app.vault.on("rename", this.enqueueUpdateStatusBar.bind(this)),
      );

      this.addCommand({
        id: "git-backup",
        name: "Backup",
        callback: () => {
          const start = Date.now();
          this.gitSync()
            .then((message) => {
              const duration = Date.now() - start;
              new Notice(`Git backup [${duration}ms]: ${message}`);
            })
            .catch((error) => {
              console.error(error);
              new Notice(`Git backup [error]: ${error}`);
            })
            .finally(() => {
              this.enqueueUpdateStatusBar();
            });
        },
      });
    }

    async unload() {
      if (this.statusBarItem) {
        this.statusBarItem.remove();
        this.statusBarItem = null;
      }
      this.statusBarUpdateLock = false;
      // TODO: Unload settings
    }

    /**
     * Load settings from disk.
     * @returns {Promise<void>}
     */
    async loadSettings() {
      this.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        await this.loadData(),
      );
    }

    /**
     * Save settings to disk.
     * @returns {Promise<void>}
     */
    async saveSettings() {
      await this.saveData(this.settings);
    }

    /**
     * Initialize the status bar item.
     */
    initStatusBarItem() {
      const item = this.addStatusBarItem();
      obsidian.setIcon(item, "git-branch");
      let span;
      span = item.createSpan();
      span.innerHTML = "&nbsp;";
      span.className = "spacer";
      span = item.createSpan();
      span.className = "git-diffstat";
      this.statusBarItem = item;
    }

    enqueueUpdateStatusBar() {
      if (this.statusBarUpdateLock) return;
      this.statusBarUpdateLock = true;
      this.updateStatusBar()
        .catch((error) => {
          console.error(error);
        })
        .finally(() => {
          this.statusBarUpdateLock = false;
        });
    }

    async updateStatusBar() {
      if (!this.statusBarItem || !this.gitBinPath) return;

      const span = this.statusBarItem.querySelector("span.git-diffstat");
      assert(span, "status bar missing span");

      const stats = await gitStat(
        this.gitBinPath,
        this.gitDir,
        this.gitWorkTree,
      );

      if (stats.filesChanged > 0) {
        span.textContent = `${stats.filesChanged} files changed`;
      } else {
        span.textContent = "No changes";
      }
    }

    /**
     * Get path to bare git repository in cache.
     * @returns {string}
     */
    get gitDir() {
      const vaultName = this.app.vault.getName();
      assert(vaultName !== "", "vaultName is not set");
      return path.join(getCacheDir(), `${vaultName}.git`);
    }

    /**
     * Get path to Vault directory to use as git work tree.
     * @returns {string}
     */
    get gitWorkTree() {
      const dataAdapter = this.app.vault.adapter;
      assert(
        dataAdapter instanceof obsidian.FileSystemAdapter,
        "dataAdapter is FileSystemAdapter",
      );
      return dataAdapter.getBasePath();
    }

    /**
     * Sync local git repository with remote.
     *
     * @returns {Promise<string>}
     */
    async gitSync() {
      assert(this.gitBinPath, "gitBinPath isn't set");
      assert(this.settings.gitRemoteURL, "gitRemoteURL isn't set");

      await gitFetch(this.gitBinPath, this.gitDir, this.settings.gitRemoteURL);

      const commitMessage = `vault backup: ${getTimestamp()}`;
      const commit = await gitCommitAll(
        this.gitBinPath,
        this.gitDir,
        this.gitWorkTree,
        commitMessage,
        this.settings.gitUserName,
        this.settings.gitUserEmail,
      );
      if (commit) {
        await gitPush(
          this.gitBinPath,
          this.gitDir,
          "origin",
          this.settings.gitBranchName,
        );
        return `Pushed ${commit.filesChanged} files`;
      } else {
        return "No changes";
      }
    }
  }

  class GitBackupSettingTab extends PluginSettingTab {
    /** @type {GitBackupPlugin} */
    plugin;

    /**
     *
     * @param {obsidian.App} app
     * @param {GitBackupPlugin} plugin
     */
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    display() {
      const { containerEl } = this;

      containerEl.empty();

      new Setting(containerEl).setName("Git Remote URL").addText((text) =>
        text
          .setValue(this.plugin.settings.gitRemoteURL)
          .onChange(async (value) => {
            this.plugin.settings.gitRemoteURL = value;
            await this.plugin.saveSettings();
          }),
      );

      new Setting(containerEl).setName("Git Branch Name").addText((text) =>
        text
          .setValue(this.plugin.settings.gitBranchName)
          .onChange(async (value) => {
            this.plugin.settings.gitBranchName = value;
            await this.plugin.saveSettings();
          }),
      );

      new Setting(containerEl).setName("Git User Name").addText((text) =>
        text
          .setValue(this.plugin.settings.gitUserName)
          .onChange(async (value) => {
            this.plugin.settings.gitUserName = value;
            await this.plugin.saveSettings();
          }),
      );

      new Setting(containerEl).setName("Git User Email").addText((text) => {
        text
          .setValue(this.plugin.settings.gitUserEmail)
          .onChange(async (value) => {
            this.plugin.settings.gitUserEmail = value;
            await this.plugin.saveSettings();
          });
      });
    }
  }

  /**
   * Get the path to the git binary.
   *
   * @returns {Promise<string | null>}
   */
  async function detectGit() {
    const env = await getShellEnv();
    const { stdout } = await execFile("which", ["git"], { env });
    const result = stdout.trim();
    return result === "" ? null : result;
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
   * Get git stats for uncommitted changes.
   *
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} gitWorkTree
   * @returns {Promise<{ filesChanged: number; insertions: number; deletions: number; }>}
   */
  async function gitStat(gitBinPath, gitDir, gitWorkTree) {
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: gitWorkTree };
    const git = execEnv.bind(null, gitBinPath, env);
    const { stdout } = await git(["diff", "--numstat", "HEAD"]);
    return parseGitDiffNumstat(stdout);
  }

  /**
   * Parse git diff --numstat output.
   *
   * @param {string} out
   * @returns {{ filesChanged: number; insertions: number; deletions: number; }}
   */
  function parseGitDiffNumstat(out) {
    const stats = {
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };

    for (const line of out.trim().split("\n")) {
      if (line.trim()) {
        const cols = line.split(/\s+/, 3);
        stats.filesChanged++;
        stats.insertions += parseInt(cols[0]);
        stats.deletions += parseInt(cols[1]);
      }
    }

    return stats;
  }

  /**
   * Run `git commit` in the given git directory.
   * @param {string} gitBinPath
   * @param {string} gitDir
   * @param {string} gitWorkTree
   * @param {string} commitMessage
   * @param {string} gitUserName
   * @param {string} gitUserEmail
   * @returns {Promise<{ commitSha: string; filesChanged: number; insertions: number; deletions: number; } | null>}
   */
  async function gitCommitAll(
    gitBinPath,
    gitDir,
    gitWorkTree,
    commitMessage,
    gitUserName,
    gitUserEmail,
  ) {
    const env = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: gitWorkTree,
      GIT_AUTHOR_NAME: gitUserName,
      GIT_AUTHOR_EMAIL: gitUserEmail,
      GIT_COMMITTER_NAME: gitUserName,
      GIT_COMMITTER_EMAIL: gitUserEmail,
    };
    const git = execEnv.bind(null, gitBinPath, env);

    try {
      await git(["reset", "--mixed", "HEAD"]);
      await git(["add", "."]);

      const { stdout } = await git(["diff", "--staged", "--numstat"]);
      const stats = parseGitDiffNumstat(stdout);

      if (stats.filesChanged > 0) {
        await git(["commit", "--message", commitMessage]);
        const { stdout } = await git(["rev-parse", "HEAD"]);
        const commitSha = stdout.trim();
        console.assert(commitSha.length === 40, "Bad commit SHA");
        return { commitSha, ...stats };
      } else {
        console.log("git commit: no changes");
        return null;
      }
    } finally {
      await unlinkForce(path.join(gitDir, "COMMIT_EDITMSG"));
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

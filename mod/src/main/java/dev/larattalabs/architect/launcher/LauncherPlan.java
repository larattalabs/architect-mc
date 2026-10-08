package dev.larattalabs.architect.launcher;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The launcher's decisions as pure functions (docs/CONTRACT.md "Launcher", "Sidecar process"), so they are unit-tested
 * without a game, a node binary or a process: where to look for node and in which order, which node is good enough, where
 * the sidecar comes from, whether a running sidecar is reused, the command line, and the state the Status tab shows. The
 * client's {@code Launcher} does the I/O around them.
 */
public final class LauncherPlan {
	/** Node major version the sidecar needs. */
	public static final int MIN_NODE = 22;
	public static final int DEFAULT_PORT = 7890;
	public static final String NODE_INSTALL_URL = "https://nodejs.org/en/download";

	private LauncherPlan() {
	}

	// ------------------------------------------------------------------ the host, injected

	/**
	 * What node discovery may look at: environment variables, the OS, the user's home, and a file system (tests pass maps).
	 *
	 * @param executable whether a path is an executable file
	 * @param list the entries of a directory (empty when it is none)
	 */
	public record Host(Map<String, String> env, String osName, String home, Predicate<Path> executable, Function<Path, List<Path>> list) {
		public boolean windows() {
			return osName.toLowerCase(Locale.ROOT).startsWith("windows");
		}

		@Nullable String get(String key) {
			String v = env.get(key);
			return v == null || v.isBlank() ? null : v;
		}
	}

	// ------------------------------------------------------------------ node discovery

	/**
	 * Where node may be, in the order it is tried (first match wins, duplicates dropped): the config's {@code nodePath};
	 * every {@code PATH} entry; {@code /opt/homebrew/bin}, {@code /usr/local/bin}; the version managers' shims and installs
	 * (mise, volta, nvm's {@code NVM_BIN} and its newest installed version, asdf, fnm); on Windows {@code %ProgramFiles%\nodejs}.
	 * A GUI-launched Minecraft has a minimal PATH, which is why the fixed places follow. The login shell
	 * ({@link #shellProbe}) is asked last, by the caller, because it spawns a process.
	 */
	public static List<Path> nodeCandidates(@Nullable String configNodePath, Host h) {
		String exe = h.windows() ? "node.exe" : "node";
		Set<Path> out = new LinkedHashSet<>();
		if (configNodePath != null && !configNodePath.isBlank()) {
			Path p = Path.of(configNodePath.strip());
			// the config may name the binary or its folder
			out.add(p.getFileName() != null && p.getFileName().toString().toLowerCase(Locale.ROOT).startsWith("node") ? p : p.resolve(exe));
		}
		String path = h.get(h.windows() ? pathKey(h.env()) : "PATH");
		if (path != null) {
			for (String dir : path.split(h.windows() ? ";" : ":")) {
				if (!dir.isBlank()) {
					out.add(Path.of(dir.strip()).resolve(exe));
				}
			}
		}
		Path home = Path.of(h.home());
		if (h.windows()) {
			String pf = h.get("ProgramFiles");
			out.add(Path.of(pf != null ? pf : "C:\\Program Files").resolve("nodejs").resolve(exe));
			String local = h.get("LOCALAPPDATA");
			if (local != null) {
				out.add(Path.of(local).resolve("Programs").resolve("nodejs").resolve(exe));
			}
			String volta = h.get("VOLTA_HOME");
			out.add((volta != null ? Path.of(volta) : Path.of(local != null ? local : h.home()).resolve("Volta")).resolve("bin").resolve(exe));
			String nvmSym = h.get("NVM_SYMLINK");
			if (nvmSym != null) {
				out.add(Path.of(nvmSym).resolve(exe));
			}
		} else {
			out.add(Path.of("/opt/homebrew/bin").resolve(exe));
			out.add(Path.of("/usr/local/bin").resolve(exe));
			String miseData = h.get("MISE_DATA_DIR");
			out.add((miseData != null ? Path.of(miseData) : home.resolve(".local/share/mise")).resolve("shims").resolve(exe));
			String volta = h.get("VOLTA_HOME");
			out.add((volta != null ? Path.of(volta) : home.resolve(".volta")).resolve("bin").resolve(exe));
			String nvmBin = h.get("NVM_BIN");
			if (nvmBin != null) {
				out.add(Path.of(nvmBin).resolve(exe));
			}
			String nvmDir = h.get("NVM_DIR");
			Path versions = (nvmDir != null ? Path.of(nvmDir) : home.resolve(".nvm")).resolve("versions").resolve("node");
			for (Path v : newestFirst(h.list().apply(versions))) {
				out.add(v.resolve("bin").resolve(exe));
			}
			out.add(home.resolve(".asdf/shims").resolve(exe));
			out.add(home.resolve(".local/share/fnm/aliases/default/bin").resolve(exe));
			out.add(Path.of("/usr/bin").resolve(exe));
		}
		return List.copyOf(out);
	}

	/** Windows env keys are case-insensitive ("Path"). */
	private static String pathKey(Map<String, String> env) {
		for (String k : env.keySet()) {
			if (k.equalsIgnoreCase("PATH")) {
				return k;
			}
		}
		return "PATH";
	}

	/** Version folders ({@code v22.11.0}) newest first by numeric version; others last. */
	static List<Path> newestFirst(List<Path> dirs) {
		List<Path> sorted = new ArrayList<>(dirs);
		sorted.sort(Comparator.comparing((Path p) -> versionKey(p.getFileName() == null ? "" : p.getFileName().toString())).reversed());
		return sorted;
	}

	private static String versionKey(String name) {
		int[] v = parseVersion(name);
		return v == null ? "" : String.format(Locale.ROOT, "%06d.%06d.%06d", v[0], v[1], v[2]);
	}

	/** The first candidate that is an executable file, or null. */
	public static @Nullable Path firstExecutable(List<Path> candidates, Host h) {
		for (Path p : candidates) {
			if (h.executable().test(p)) {
				return p;
			}
		}
		return null;
	}

	/**
	 * The process that asks the user's login shell for node (it sets up PATH from the profile, version managers included):
	 * {@code $SHELL -lc 'command -v node'} (default {@code /bin/zsh} on macOS, {@code /bin/bash} elsewhere), or
	 * {@code where node} on Windows.
	 */
	public static List<String> shellProbe(Host h) {
		if (h.windows()) {
			return List.of("where", "node");
		}
		String shell = h.get("SHELL");
		if (shell == null) {
			shell = h.osName().toLowerCase(Locale.ROOT).contains("mac") ? "/bin/zsh" : "/bin/bash";
		}
		return List.of(shell, "-lc", "command -v node");
	}

	/** The node path in a probe's output: the last line that looks like an absolute path (profiles may print banners). */
	public static @Nullable Path parseProbe(String output) {
		Path found = null;
		for (String line : output.split("\\R")) {
			String t = line.strip();
			if (t.startsWith("/") || t.matches("^[A-Za-z]:\\\\.*")) {
				found = Path.of(t);
			}
		}
		return found;
	}

	private static final Pattern VERSION = Pattern.compile("v?(\\d+)\\.(\\d+)\\.(\\d+)");

	/** {@code v22.11.0} -> {22, 11, 0}; null when it is not a version. */
	public static int @Nullable [] parseVersion(@Nullable String s) {
		if (s == null) {
			return null;
		}
		Matcher m = VERSION.matcher(s.strip());
		if (!m.find()) {
			return null;
		}
		return new int[] {Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))};
	}

	/** Whether {@code node --version}'s output is new enough ({@value #MIN_NODE}+). */
	public static boolean nodeOk(@Nullable String versionOutput) {
		int[] v = parseVersion(versionOutput);
		return v != null && v[0] >= MIN_NODE;
	}

	/** npm next to node ({@code npm.cmd} on Windows). */
	public static Path npmFor(Path node, boolean windows) {
		Path dir = node.toAbsolutePath().getParent();
		return dir == null ? Path.of(windows ? "npm.cmd" : "npm") : dir.resolve(windows ? "npm.cmd" : "npm");
	}

	/** The install command for a bundled sidecar: {@code npm ci --omit=dev} with a lock file, else {@code npm install --omit=dev}. */
	public static List<String> installCommand(Path npm, boolean hasLockFile) {
		return List.of(npm.toString(), hasLockFile ? "ci" : "install", "--omit=dev", "--no-audit", "--no-fund");
	}

	// ------------------------------------------------------------------ where the sidecar comes from

	public enum SourceKind {
		/** {@code -Darchitect.sidecarDir} / {@code ARCHITECT_SIDECAR_DIR}: a dev checkout's {@code sidecar/}, run as is. */
		DEV,
		/** The jar's {@code architect-sidecar/}, extracted to {@code <gameDir>/architect/sidecar/<modVersion>/} and installed. */
		BUNDLED,
		/** Neither: nothing to launch (a build without the sidecar). */
		NONE
	}

	/**
	 * Where the sidecar runs from and where its kit is.
	 *
	 * @param dir the folder holding {@code dist/main.mjs} (null for NONE)
	 * @param kit the blueprint kit folder passed as {@code --kit} (null when none was found)
	 * @param origin where it was configured ("-Darchitect.sidecarDir", "ARCHITECT_SIDECAR_DIR", "bundled", "none")
	 */
	public record Source(SourceKind kind, @Nullable Path dir, @Nullable Path kit, String origin) {
	}

	/**
	 * The sidecar's source (first match wins): the system property, the environment variable, the bundle in the jar; else
	 * NONE. A dev dir's kit is {@code ARCHITECT_KIT_DIR}, else the checkout's {@code ../kit} when it is a directory; a bundle's
	 * kit is the extracted {@code kit/}.
	 */
	public static Source source(@Nullable String sysProp, @Nullable String envVar, @Nullable String kitEnv, boolean bundled, Path gameDir,
		String modVersion, Predicate<Path> isDir) {
		String devDir = sysProp != null && !sysProp.isBlank() ? sysProp : envVar != null && !envVar.isBlank() ? envVar : null;
		if (devDir != null) {
			Path dir = Path.of(devDir.strip()).toAbsolutePath().normalize();
			Path kit = kitEnv != null && !kitEnv.isBlank() ? Path.of(kitEnv.strip()).toAbsolutePath().normalize() : null;
			if (kit == null && dir.getParent() != null && isDir.test(dir.getParent().resolve("kit"))) {
				kit = dir.getParent().resolve("kit");
			}
			return new Source(SourceKind.DEV, dir, kit, sysProp != null && !sysProp.isBlank() ? "-Darchitect.sidecarDir" : "ARCHITECT_SIDECAR_DIR");
		}
		if (bundled) {
			Path dir = extractDir(gameDir, modVersion);
			return new Source(SourceKind.BUNDLED, dir, dir.resolve("kit"), "bundled");
		}
		return new Source(SourceKind.NONE, null, null, "none");
	}

	/** {@code <gameDir>/architect/sidecar/<modVersion>/} (the version made path-safe). */
	public static Path extractDir(Path gameDir, String modVersion) {
		return gameDir.resolve("architect").resolve("sidecar").resolve(modVersion.replaceAll("[^A-Za-z0-9._+-]", "_"));
	}

	// ------------------------------------------------------------------ reuse a running sidecar

	public enum Reuse {
		/** The port answers {@code hello} with our version: use it, start nothing (and never stop it on exit). */
		REUSE,
		/** Nothing answers: start ours. */
		START,
		/** Something we started earlier answers with another version (or hangs): stop it, then start ours. */
		STOP_THEN_START,
		/** Another version answers that we did not start: leave it alone and report the port as taken. */
		PORT_TAKEN
	}

	/**
	 * What to do about whatever runs on the port (docs/CONTRACT.md "Sidecar process").
	 *
	 * @param answeredVersion the version the port's {@code hello} answered with ("" when it answered without one), null when
	 *                        nothing answered
	 * @param ourVersion the version of the sidecar we would start (its package.json), null when unknown (then any answer is
	 *                   reused)
	 * @param recordedPid the pid in {@code sidecar.json} (0 = none)
	 * @param ownedPid the pid our launcher recorded when it started a sidecar ({@code launcher.json}, 0 = none)
	 * @param recordedAlive whether {@code recordedPid} is a live process
	 */
	public static Reuse reuse(@Nullable String answeredVersion, @Nullable String ourVersion, long recordedPid, long ownedPid, boolean recordedAlive) {
		boolean ours = recordedPid > 0 && recordedPid == ownedPid && recordedAlive;
		if (answeredVersion != null) {
			if (ourVersion == null || ourVersion.equals(answeredVersion)) {
				return Reuse.REUSE;
			}
			return ours ? Reuse.STOP_THEN_START : Reuse.PORT_TAKEN;
		}
		// nothing answers: a sidecar.json is stale (crashed) or the process hangs; stop a live one only when we started it
		return ours ? Reuse.STOP_THEN_START : Reuse.START;
	}

	/** How far a process's start may lie after the launcher's recorded spawn time and still be the one it spawned. */
	public static final long SAME_PROCESS_MS = 10_000;

	/**
	 * Whether a live pid is really the sidecar our launcher spawned, not a later process that reused the pid: its start time
	 * ({@code processStartMs}, -1 when the OS does not say) lies within {@link #SAME_PROCESS_MS} after the spawn time recorded
	 * in {@code launcher.json} ({@code spawnedAtMs}, 0 when unknown). Unknown is false: the launcher never kills a process it
	 * cannot identify.
	 */
	public static boolean sameProcess(long processStartMs, long spawnedAtMs) {
		if (processStartMs < 0 || spawnedAtMs <= 0) {
			return false;
		}
		return processStartMs >= spawnedAtMs - 2_000 && processStartMs <= spawnedAtMs + SAME_PROCESS_MS;
	}

	// ------------------------------------------------------------------ the command line

	/**
	 * {@code node <dir>/dist/main.mjs --port <port> --data <data> --library <library> [--kit <kit>] --parent-pid <pid>
	 * [--use-claude-login]} (docs/CONTRACT.md "Sidecar process").
	 */
	public static List<String> command(Path node, Path sidecarDir, int port, Path data, Path library, @Nullable Path kit, long parentPid,
		boolean useClaudeLogin) {
		return command(node, sidecarDir, port, data, library, kit, parentPid, useClaudeLogin, null);
	}

	/**
	 * As above, plus {@code --backend <backend>} when it is {@code sim} or {@code claude} (the dev switch
	 * {@code ARCHITECT_SIDECAR_BACKEND}: {@code sim} runs designs and jobs without Claude, for tests); anything else is ignored.
	 */
	public static List<String> command(Path node, Path sidecarDir, int port, Path data, Path library, @Nullable Path kit, long parentPid,
		boolean useClaudeLogin, @Nullable String backend) {
		List<String> c = new ArrayList<>(List.of(node.toString(), sidecarDir.resolve("dist").resolve("main.mjs").toString(), "--port",
			Integer.toString(port), "--data", data.toString(), "--library", library.toString()));
		if (kit != null) {
			c.add("--kit");
			c.add(kit.toString());
		}
		c.add("--parent-pid");
		c.add(Long.toString(parentPid));
		if (useClaudeLogin) {
			c.add("--use-claude-login");
		}
		if ("sim".equals(backend) || "claude".equals(backend)) {
			c.add("--backend");
			c.add(backend);
		}
		return List.copyOf(c);
	}

	/**
	 * The environment for the sidecar: the game's, with node's folder first on PATH (Minecraft's PATH is minimal and the
	 * design agent runs {@code node kit/build.mjs}). The caller adds nothing secret here: auth goes through {@code auth.set}.
	 */
	public static Map<String, String> environment(Map<String, String> base, Path node, boolean windows) {
		return environment(base, node, windows, System.getProperty("user.name"), System.getProperty("user.home"));
	}

	/**
	 * {@link #environment}; {@code userName} and {@code userHome} ({@code user.name}, {@code user.home}) fill {@code USER},
	 * {@code LOGNAME} and {@code HOME} when the game was started without them (docs/CONTRACT.md phase 5b F2: the claude CLI
	 * did not find its login from a scrubbed environment). Variables that are set are never changed.
	 */
	public static Map<String, String> environment(Map<String, String> base, Path node, boolean windows, @Nullable String userName,
		@Nullable String userHome) {
		Map<String, String> env = new java.util.HashMap<>(base);
		if (!windows) {
			for (String k : new String[] {"USER", "LOGNAME"}) {
				String v = env.get(k);
				if ((v == null || v.isBlank()) && userName != null && !userName.isBlank()) {
					env.put(k, userName);
				}
			}
			String h = env.get("HOME");
			if ((h == null || h.isBlank()) && userHome != null && !userHome.isBlank()) {
				env.put("HOME", userHome);
			}
		}
		String key = windows ? pathKey(base) : "PATH";
		String sep = windows ? ";" : ":";
		Path dir = node.toAbsolutePath().getParent();
		if (dir != null) {
			String old = env.get(key);
			env.put(key, dir + (old == null || old.isBlank() ? "" : sep + old));
		}
		return env;
	}

	// ------------------------------------------------------------------ state

	/** The launcher's state for the Status tab and the toast (docs/CONTRACT.md "Launcher"). */
	public enum State {
		/** Not started yet. */
		IDLE,
		/** No node 22+ found (with an install link). */
		NODE_MISSING,
		/** Extracting the bundle / {@code npm ci} (the npm progress line). */
		INSTALLING,
		/** Spawned (or reusing), waiting for the link. */
		STARTING,
		/** The link is synced. */
		RUNNING,
		/** The sidecar exited or never answered (the last 20 log lines). */
		CRASHED,
		/** {@code autoStart} off, no sidecar in this build, or the port taken by another version. */
		DISABLED;

		public String wire() {
			return name().toLowerCase(Locale.ROOT).replace('_', '-');
		}
	}

	/** The last {@code n} non-blank lines of a log. */
	public static List<String> tail(List<String> lines, int n) {
		List<String> nonBlank = new ArrayList<>();
		for (String l : lines) {
			if (!l.isBlank()) {
				nonBlank.add(l);
			}
		}
		return List.copyOf(nonBlank.subList(Math.max(0, nonBlank.size() - n), nonBlank.size()));
	}
}

package dev.larattalabs.architect.launcher;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.launcher.LauncherPlan.Host;
import dev.larattalabs.architect.launcher.LauncherPlan.Reuse;
import dev.larattalabs.architect.launcher.LauncherPlan.SourceKind;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class LauncherPlanTest {
	static Host mac(Map<String, String> env, Set<String> executables) {
		return new Host(env, "Mac OS X", "/Users/me", p -> executables.contains(p.toString()), dir -> {
			if (dir.toString().equals("/Users/me/.nvm/versions/node")) {
				return List.of(Path.of("/Users/me/.nvm/versions/node/v20.9.0"), Path.of("/Users/me/.nvm/versions/node/v22.11.0"),
					Path.of("/Users/me/.nvm/versions/node/v9.0.0"));
			}
			return List.of();
		});
	}

	@Test
	void discoveryOrderOnMac() {
		Host h = mac(Map.of("PATH", "/usr/bin:/bin", "SHELL", "/bin/zsh"), Set.of());
		List<String> c = LauncherPlan.nodeCandidates("/opt/custom/node", h).stream().map(Path::toString).toList();
		assertEquals(List.of("/opt/custom/node", "/usr/bin/node", "/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node",
			"/Users/me/.local/share/mise/shims/node", "/Users/me/.volta/bin/node", "/Users/me/.nvm/versions/node/v22.11.0/bin/node",
			"/Users/me/.nvm/versions/node/v20.9.0/bin/node", "/Users/me/.nvm/versions/node/v9.0.0/bin/node", "/Users/me/.asdf/shims/node",
			"/Users/me/.local/share/fnm/aliases/default/bin/node"), c);
		// a config naming a folder gets node appended; no config, no entry
		assertEquals("/opt/n/bin/node", LauncherPlan.nodeCandidates("/opt/n/bin", h).get(0).toString());
		assertEquals("/usr/bin/node", LauncherPlan.nodeCandidates(" ", h).get(0).toString());
	}

	@Test
	void versionManagersFollowTheirEnvironment() {
		Host h = mac(Map.of("PATH", "/usr/bin", "MISE_DATA_DIR", "/data/mise", "VOLTA_HOME", "/v", "NVM_BIN", "/n/bin", "NVM_DIR", "/nvm"), Set.of());
		List<String> c = LauncherPlan.nodeCandidates(null, h).stream().map(Path::toString).toList();
		assertTrue(c.indexOf("/data/mise/shims/node") < c.indexOf("/v/bin/node"));
		assertTrue(c.indexOf("/v/bin/node") < c.indexOf("/n/bin/node"));
	}

	@Test
	void firstExecutableWinsAndAMinimalPathStillFindsHomebrew() {
		// Minecraft launched from the Dock: PATH=/usr/bin:/bin, node lives in Homebrew
		Host h = mac(Map.of("PATH", "/usr/bin:/bin"), Set.of("/opt/homebrew/bin/node", "/Users/me/.volta/bin/node"));
		assertEquals(Path.of("/opt/homebrew/bin/node"), LauncherPlan.firstExecutable(LauncherPlan.nodeCandidates(null, h), h));
		Host none = mac(Map.of("PATH", "/usr/bin:/bin"), Set.of());
		assertNull(LauncherPlan.firstExecutable(LauncherPlan.nodeCandidates(null, none), none), "node-missing");
	}

	@Test
	void windowsDiscovery() {
		Host h = new Host(Map.of("Path", "C:\\tools;C:\\Windows", "ProgramFiles", "C:\\Program Files", "LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local"),
			"Windows 11", "C:\\Users\\me", p -> false, d -> List.of());
		List<String> c = LauncherPlan.nodeCandidates(null, h).stream().map(Path::toString).toList();
		assertTrue(c.get(0).endsWith("node.exe"), c.toString());
		assertTrue(c.stream().anyMatch(s -> s.contains("nodejs")), c.toString());
		assertEquals(List.of("where", "node"), LauncherPlan.shellProbe(h));
		assertTrue(LauncherPlan.npmFor(Path.of("C:\\nodejs\\node.exe"), true).toString().endsWith("npm.cmd"));
	}

	@Test
	void loginShellProbe() {
		assertEquals(List.of("/bin/fish", "-lc", "command -v node"), LauncherPlan.shellProbe(mac(Map.of("SHELL", "/bin/fish"), Set.of())));
		assertEquals("/bin/zsh", LauncherPlan.shellProbe(mac(Map.of(), Set.of())).get(0));
		assertEquals(Path.of("/Users/me/.nvm/versions/node/v22.1.0/bin/node"),
			LauncherPlan.parseProbe("Welcome back!\n/Users/me/.nvm/versions/node/v22.1.0/bin/node\n"));
		assertNull(LauncherPlan.parseProbe("node not found\n"));
	}

	@Test
	void nodeVersion() {
		assertTrue(LauncherPlan.nodeOk("v22.0.0"));
		assertTrue(LauncherPlan.nodeOk("v24.16.0\n"));
		assertFalse(LauncherPlan.nodeOk("v20.18.1"));
		assertFalse(LauncherPlan.nodeOk("garbage"));
		assertFalse(LauncherPlan.nodeOk(null));
		assertArrayEquals(new int[] {22, 11, 0}, LauncherPlan.parseVersion("v22.11.0"));
	}

	@Test
	void sidecarSource() {
		Path game = Path.of("/games/mc");
		var dev = LauncherPlan.source("/repo/sidecar", "/other", null, true, game, "0.1.0", p -> p.toString().equals("/repo/kit"));
		assertEquals(SourceKind.DEV, dev.kind());
		assertEquals(Path.of("/repo/sidecar"), dev.dir());
		assertEquals(Path.of("/repo/kit"), dev.kit());
		assertEquals("-Darchitect.sidecarDir", dev.origin());
		var env = LauncherPlan.source(null, "/repo/sidecar", "/k", false, game, "0.1.0", p -> false);
		assertEquals("ARCHITECT_SIDECAR_DIR", env.origin());
		assertEquals(Path.of("/k"), env.kit());
		var bundled = LauncherPlan.source(" ", null, null, true, game, "0.1.0+mc", p -> false);
		assertEquals(SourceKind.BUNDLED, bundled.kind());
		assertEquals(Path.of("/games/mc/architect/sidecar/0.1.0+mc"), bundled.dir());
		assertEquals(Path.of("/games/mc/architect/sidecar/0.1.0+mc/kit"), bundled.kit());
		var none = LauncherPlan.source(null, null, null, false, game, "0.1.0", p -> false);
		assertEquals(SourceKind.NONE, none.kind());
		assertNull(none.dir());
	}

	@Test
	void reuseOrStart() {
		// our version answers: reuse whoever started it
		assertEquals(Reuse.REUSE, LauncherPlan.reuse("0.1.0", "0.1.0", 0, 0, false));
		assertEquals(Reuse.REUSE, LauncherPlan.reuse("0.1.0", "0.1.0", 42, 7, true));
		// unknown expected version: any answer is reused
		assertEquals(Reuse.REUSE, LauncherPlan.reuse("9.9.9", null, 0, 0, false));
		// another version: stop it only when we started it
		assertEquals(Reuse.STOP_THEN_START, LauncherPlan.reuse("0.0.9", "0.1.0", 42, 42, true));
		assertEquals(Reuse.PORT_TAKEN, LauncherPlan.reuse("0.0.9", "0.1.0", 42, 7, true));
		assertEquals(Reuse.PORT_TAKEN, LauncherPlan.reuse("0.0.9", "0.1.0", 0, 0, false));
		// nothing answers: a stale sidecar.json starts fresh; a live hung one of ours is stopped first
		assertEquals(Reuse.START, LauncherPlan.reuse(null, "0.1.0", 42, 42, false));
		assertEquals(Reuse.START, LauncherPlan.reuse(null, "0.1.0", 42, 7, true));
		assertEquals(Reuse.STOP_THEN_START, LauncherPlan.reuse(null, "0.1.0", 42, 42, true));
		assertEquals(Reuse.START, LauncherPlan.reuse(null, "0.1.0", 0, 0, false));
	}

	@Test
	void aReusedPidIsNeverOurs() {
		long spawned = 1_759_600_000_000L;
		assertTrue(LauncherPlan.sameProcess(spawned + 30, spawned));
		assertTrue(LauncherPlan.sameProcess(spawned - 500, spawned)); // clocks round
		// the pid came back days later for another program
		assertFalse(LauncherPlan.sameProcess(spawned + 3L * 24 * 3600 * 1000, spawned));
		assertFalse(LauncherPlan.sameProcess(spawned - 60_000, spawned));
		// unknown start time or spawn time: not ours (never killed)
		assertFalse(LauncherPlan.sameProcess(-1, spawned));
		assertFalse(LauncherPlan.sameProcess(spawned, 0));
	}

	@Test
	void commandLine() {
		List<String> c = LauncherPlan.command(Path.of("/opt/homebrew/bin/node"), Path.of("/s"), 7890, Path.of("/g/architect/sidecar-data"),
			Path.of("/g/architect/library"), Path.of("/s/kit"), 1234, false);
		assertEquals(List.of("/opt/homebrew/bin/node", "/s/dist/main.mjs", "--port", "7890", "--data", "/g/architect/sidecar-data", "--library",
			"/g/architect/library", "--kit", "/s/kit", "--parent-pid", "1234"), c);
		List<String> login = LauncherPlan.command(Path.of("node"), Path.of("/s"), 7999, Path.of("/d"), Path.of("/l"), null, 1, true);
		assertFalse(login.contains("--kit"));
		assertEquals("--use-claude-login", login.get(login.size() - 1));
		List<String> sim = LauncherPlan.command(Path.of("node"), Path.of("/s"), 7999, Path.of("/d"), Path.of("/l"), null, 1, false, "sim");
		assertEquals(List.of("--backend", "sim"), sim.subList(sim.size() - 2, sim.size()));
		assertFalse(LauncherPlan.command(Path.of("node"), Path.of("/s"), 7999, Path.of("/d"), Path.of("/l"), null, 1, false, "--evil").contains("--evil"));
		assertEquals(List.of("/n/npm", "ci", "--omit=dev", "--no-audit", "--no-fund"), LauncherPlan.installCommand(Path.of("/n/npm"), true));
		assertEquals("install", LauncherPlan.installCommand(Path.of("/n/npm"), false).get(1));
		// (6c 0a) the sim backend skips npm ci (the install is only for the Agent SDK)
		assertFalse(LauncherPlan.needsInstall("sim"));
		assertTrue(LauncherPlan.needsInstall(null));
		assertTrue(LauncherPlan.needsInstall("claude"));
	}

	@Test
	void environmentPutsNodeFirst() {
		Map<String, String> env = LauncherPlan.environment(Map.of("PATH", "/usr/bin:/bin", "HOME", "/Users/me"), Path.of("/opt/homebrew/bin/node"), false);
		assertEquals("/opt/homebrew/bin:/usr/bin:/bin", env.get("PATH"));
		assertEquals("/Users/me", env.get("HOME"));
	}

	@Test
	void environmentFillsUserLognameAndHomeWhenMissing() {
		// phase 5b F2: a game started from `env -i` has no USER/LOGNAME; the claude CLI then found no login
		Map<String, String> env = LauncherPlan.environment(Map.of("PATH", "/usr/bin"), Path.of("/n/node"), false, "noah", "/Users/noah");
		assertEquals("noah", env.get("USER"));
		assertEquals("noah", env.get("LOGNAME"));
		assertEquals("/Users/noah", env.get("HOME"));
		Map<String, String> kept = LauncherPlan.environment(Map.of("PATH", "/usr/bin", "USER", "a", "LOGNAME", "b", "HOME", "/h"), Path.of("/n/node"), false,
			"noah", "/Users/noah");
		assertEquals("a", kept.get("USER"));
		assertEquals("b", kept.get("LOGNAME"));
		assertEquals("/h", kept.get("HOME"));
		Map<String, String> blank = LauncherPlan.environment(Map.of("PATH", "/usr/bin", "USER", " "), Path.of("/n/node"), false, "noah", null);
		assertEquals("noah", blank.get("USER"));
		assertFalse(blank.containsKey("HOME"));
		assertFalse(LauncherPlan.environment(Map.of("Path", "C:\\x"), Path.of("C:\\n\\node.exe"), true, "noah", "C:\\Users\\noah").containsKey("USER"));
	}

	@Test
	void stateNamesAndTail() {
		assertEquals("node-missing", LauncherPlan.State.NODE_MISSING.wire());
		assertEquals("running", LauncherPlan.State.RUNNING.wire());
		assertEquals(List.of("b", "c"), LauncherPlan.tail(List.of("a", "", "b", "  ", "c"), 2));
		assertEquals(List.of("a"), LauncherPlan.tail(List.of("a"), 20));
	}
}

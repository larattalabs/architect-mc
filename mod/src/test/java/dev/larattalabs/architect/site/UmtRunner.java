package dev.larattalabs.architect.site;

import dev.larattalabs.architect.site.UmtOps.Op;
import dev.larattalabs.architect.site.UmtOps.Scenario;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import java.util.stream.Stream;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;

/** Runs UMT scenarios (each in its own journal folder) and shrinks a failing one to a minimal list of operations (docs/UMT.md). */
final class UmtRunner {
	private static boolean booted;

	private UmtRunner() {
	}

	static synchronized void boot() {
		if (!booted) {
			SharedConstants.tryDetectVersion();
			Bootstrap.bootStrap();
			booted = true;
		}
	}

	/** What one run found: its violations (empty: exact) and the report (scenario, trace, violations). */
	record Result(Scenario scenario, List<String> violations, String report) {
		boolean failed() {
			return !violations.isEmpty();
		}
	}

	static synchronized Result run(Scenario sc) {
		boot();
		Path dir;
		try {
			dir = Files.createTempDirectory("umt");
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
		UmtSim sim = null;
		try {
			sim = new UmtSim(sc, dir.resolve("world"));
			List<String> v;
			try {
				v = sim.run();
			} catch (Exception | AssertionError e) {
				v = new ArrayList<>(sim.violations);
				v.add("exception: " + e);
				java.io.StringWriter w = new java.io.StringWriter();
				e.printStackTrace(new java.io.PrintWriter(w));
				sim.trace.add(w.toString());
			}
			return new Result(sc, List.copyOf(v), sim.report());
		} catch (IOException e) {
			throw new IllegalStateException(e);
		} finally {
			if (sim != null) {
				sim.close();
			}
			delete(dir);
		}
	}

	private static void delete(Path dir) {
		try (Stream<Path> s = Files.walk(dir)) {
			for (Path p : s.sorted(Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(p);
			}
		} catch (IOException e) {
			// a temp folder left behind
		}
	}

	/**
	 * Shrinks a failing scenario (delta debugging over its operations, then crashes dropped where the failure stays): the smallest
	 * scenario found whose run still fails with a violation of the same kind (its first word group before a colon).
	 */
	static Result shrink(Result failing) {
		return shrink(failing, kind(failing.violations().get(0)));
	}

	static Result shrink(Result failing, String kind) {
		Predicate<Scenario> fails = s -> {
			Result r = run(s);
			return r.failed() && r.violations().stream().anyMatch(v -> kind(v).equals(kind));
		};
		List<Op> ops = new ArrayList<>(failing.scenario().ops());
		int n = 2;
		while (ops.size() >= 2) {
			int chunk = Math.max(1, ops.size() / n);
			boolean reduced = false;
			for (int start = 0; start < ops.size(); start += chunk) {
				List<Op> without = new ArrayList<>(ops.subList(0, start));
				without.addAll(ops.subList(Math.min(ops.size(), start + chunk), ops.size()));
				if (!without.isEmpty() && fails.test(failing.scenario().with(without))) {
					ops = without;
					n = Math.max(n - 1, 2);
					reduced = true;
					break;
				}
			}
			if (!reduced) {
				if (chunk == 1) {
					break;
				}
				n = Math.min(ops.size(), n * 2);
			}
		}
		// crashes and groups made simpler where the failure stays
		for (int i = 0; i < ops.size(); i++) {
			Op o = ops.get(i);
			Op simpler = switch (o) {
				case UmtOps.Place p when p.crash() != null -> new UmtOps.Place(p.kind(), p.x(), p.z(), p.w(), p.d(), p.h(), p.design(), p.group(), null);
				case UmtOps.Remove r when r.crash() != null -> new UmtOps.Remove(r.ordinal(), null);
				case UmtOps.RemoveGroup g when g.crash() != null -> new UmtOps.RemoveGroup(g.group(), null);
				default -> null;
			};
			if (simpler != null) {
				List<Op> t = new ArrayList<>(ops);
				t.set(i, simpler);
				if (fails.test(failing.scenario().with(t))) {
					ops = t;
				}
			}
		}
		return run(failing.scenario().with(ops));
	}

	/** Whether a violation belongs to a documented finding ([F1], [F2], [LP], ...: docs/UMT.md "Findings"). */
	static boolean known(String violation) {
		return violation.startsWith("[");
	}

	static String kind(String violation) {
		int c = violation.indexOf(':');
		String head = c < 0 ? violation : violation.substring(0, c);
		return head.replaceAll("[0-9]+", "#").replaceAll("removing [^ ]+", "removing X").replaceAll("group \\[[^]]*\\]", "group X");
	}
}

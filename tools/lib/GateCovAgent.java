import java.io.IOException;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.ProtectionDomain;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.jar.JarFile;

/**
 * Gate execution coverage (docs/GATES.md "Execution coverage (JaCoCo)"): a test and gate tool, never part of the mod. Every JVM a
 * gate step starts gets it through JAVA_TOOL_OPTIONS (-javaagent:gate-cov-agent.jar=dir=...;jar=...;pkg=...;includes=...). It
 * <ol>
 * <li>starts the pinned JaCoCo runtime agent (output=none: nothing is written by JaCoCo itself) on the project's classes;</li>
 * <li>notes every project class JaCoCo did not instrument (a class with no code, or one JaCoCo refused): those count as entered;</li>
 * <li>writes the classes this JVM ENTERED (any method or static initializer started) to {@code <dir>/jvm-<pid>.entered}, when the
 * runner asks (it writes a new token to {@code <dir>/dump.req} at a step's end) and at exit. The data is never reset: a client
 * reused across steps stays cumulative.</li>
 * </ol>
 * "Entered" is the JaCoCo store's presence, not its probe hits: the store registers a class when any of its instrumented methods
 * starts ($jacocoInit runs first), before any probe can fire, while a probe only fires after the code before it completed. A
 * method that throws before its first probe has no hits but is in the store. The stock dump drops entries with no hits, so the
 * store is read here (RuntimeData.collect) and every entry is kept.
 * <p>
 * Any failure leaves the JVM alone and writes {@code jvm-<pid>.agent-error}: the runner then counts every class that JVM loaded
 * as entered (the class-load log is the fallback).
 */
public final class GateCovAgent {
	private static Path dir;
	private static long pid;
	private static Object data;
	private static Method collect;
	private static Class<?> execVisitor;
	private static Class<?> sessionVisitor;
	private static Method getName;
	private static String prefix;
	private static final Set<String> uninstrumented = ConcurrentHashMap.newKeySet();
	private static volatile String last = "";

	public static void premain(String args, Instrumentation inst) {
		pid = ProcessHandle.current().pid();
		try {
			String jar = null, pkg = null, includes = "dev.larattalabs.*";
			for (String kv : args.split(";")) {
				int i = kv.indexOf('=');
				if (i < 0) continue;
				String k = kv.substring(0, i), v = kv.substring(i + 1);
				switch (k) {
					case "dir" -> dir = Path.of(v);
					case "jar" -> jar = v;
					case "pkg" -> pkg = v;
					case "includes" -> includes = v;
					default -> {
					}
				}
			}
			if (dir == null || jar == null || pkg == null) throw new IllegalArgumentException("dir, jar and pkg are required: " + args);
			Files.createDirectories(dir);
			prefix = includes.replace(".*", "").replace('.', '/') + "/";
			inst.appendToSystemClassLoaderSearch(new JarFile(jar));
			ClassLoader sys = ClassLoader.getSystemClassLoader();
			String base = "org.jacoco.agent.rt." + pkg;
			Class.forName(base + ".PreMain", true, sys).getMethod("premain", String.class, Instrumentation.class).invoke(null,
				"output=none,dumponexit=false,jmx=false,inclnolocationclasses=true,includes=" + includes + ",excludes=*.mixin.*", inst);
			Object agent = Class.forName(base + ".Agent", true, sys).getMethod("getInstance").invoke(null);
			data = agent.getClass().getMethod("getData").invoke(agent);
			execVisitor = Class.forName(base + ".core.data.IExecutionDataVisitor", true, sys);
			sessionVisitor = Class.forName(base + ".core.data.ISessionInfoVisitor", true, sys);
			collect = data.getClass().getMethod("collect", execVisitor, sessionVisitor, boolean.class);
			getName = Class.forName(base + ".core.data.ExecutionData", true, sys).getMethod("getName");
			// after JaCoCo's transformer (added first, so it runs first): a project class that comes out without $jacocoInit was not
			// instrumented, so its execution is invisible: it counts as entered
			inst.addTransformer(new ClassFileTransformer() {
				@Override
				public byte[] transform(ClassLoader loader, String name, Class<?> redefined, ProtectionDomain pd, byte[] bytes) {
					if (name != null && name.startsWith(prefix) && !name.contains("/mixin/") && !contains(bytes, JACOCO_INIT)) uninstrumented.add(name);
					return null;
				}
			});
			write(dir.resolve("jvm-" + pid + ".agent"), "pid " + pid + "\nstarted " + System.currentTimeMillis() + "\njacoco " + pkg + "\n");
			Runtime.getRuntime().addShutdownHook(new Thread(() -> dump("exit"), "gate-cov-exit"));
			Thread t = new Thread(GateCovAgent::poll, "gate-cov-poll");
			t.setDaemon(true);
			t.start();
		} catch (Throwable e) {
			try {
				if (dir != null) write(dir.resolve("jvm-" + pid + ".agent-error"), String.valueOf(e) + "\n");
			} catch (Throwable ignored) {
				// nothing more to do: the runner sees no .agent marker and falls back to the class-load log
			}
		}
	}

	private static final byte[] JACOCO_INIT = "$jacocoInit".getBytes(StandardCharsets.UTF_8);

	static boolean contains(byte[] hay, byte[] needle) {
		outer:
		for (int i = 0; i <= hay.length - needle.length; i++) {
			for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
			return true;
		}
		return false;
	}

	private static void poll() {
		Path req = dir.resolve("dump.req");
		while (true) {
			try {
				Thread.sleep(200);
				if (!Files.exists(req)) continue;
				String tok = Files.readString(req).trim();
				if (!tok.isEmpty() && !tok.equals(last)) dump(tok);
			} catch (InterruptedException e) {
				return;
			} catch (Throwable ignored) {
				// a half-written request: read again next time
			}
		}
	}

	private static synchronized void dump(String token) {
		try {
			Set<String> entered = new TreeSet<>();
			InvocationHandler onClass = (p, m, a) -> {
				if (m.getName().equals("visitClassExecution")) entered.add((String) getName.invoke(a[0]));
				return null;
			};
			InvocationHandler onSession = (p, m, a) -> null;
			ClassLoader sys = ClassLoader.getSystemClassLoader();
			Object ev = Proxy.newProxyInstance(sys, new Class<?>[] {execVisitor}, onClass);
			Object sv = Proxy.newProxyInstance(sys, new Class<?>[] {sessionVisitor}, onSession);
			collect.invoke(data, ev, sv, false); // never reset: cumulative
			StringBuilder sb = new StringBuilder();
			sb.append("# token ").append(token).append('\n').append("# at ").append(System.currentTimeMillis()).append('\n');
			for (String n : entered) sb.append("e ").append(n).append('\n');
			for (String n : new TreeSet<>(uninstrumented)) sb.append("u ").append(n).append('\n');
			write(dir.resolve("jvm-" + pid + ".entered"), sb.toString());
			last = token;
		} catch (Throwable e) {
			try {
				write(dir.resolve("jvm-" + pid + ".agent-error"), "dump " + token + ": " + e + "\n");
			} catch (Throwable ignored) {
				// the runner falls back to the class-load log for this JVM
			}
		}
	}

	private static void write(Path f, String text) throws IOException {
		Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
		Files.writeString(tmp, text);
		Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
	}
}

package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Reason;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;

/**
 * (6c slice 0a; docs/CONTRACT.md "Phase 6c slice 0a" §10) WORLD_STOPPED: every future the API hands out is tracked; at
 * SERVER_STOPPING the pending ones fail with {@link ArchitectRefused} {@link Reason#WORLD_STOPPED} (a future that fails while the
 * world stops gets that reason too), and while no world runs the calls that need one fail at once with it. Work in the helper
 * goes on: the caller finds it again after the next load (the {@code *ByKey} lookups, the listings). The API objects are wrapped in
 * a {@link Proxy} of their interface, so every method that returns a {@link CompletableFuture} is covered. Internal.
 */
public final class StopSweep {
	private StopSweep() {
	}

	private static final Set<CompletableFuture<?>> PENDING = ConcurrentHashMap.newKeySet();
	private static volatile BooleanSupplier stopping = () -> false;

	static void stoppingFlag(BooleanSupplier s) {
		stopping = s;
	}

	/** The refusal a stopped world gives. */
	public static ArchitectRefused stopped(String what) {
		return new ArchitectRefused(Reason.WORLD_STOPPED, what);
	}

	/** The future the caller gets for {@code f}: it fails WORLD_STOPPED when the world stops first. */
	public static <T> CompletableFuture<T> track(CompletableFuture<T> f) {
		if (f.isDone()) {
			return f;
		}
		CompletableFuture<T> out = new CompletableFuture<>();
		PENDING.add(out);
		f.whenComplete((v, e) -> {
			PENDING.remove(out);
			if (e == null) {
				out.complete(v);
				return;
			}
			Throwable c = e instanceof CompletionException && e.getCause() != null ? e.getCause() : e;
			out.completeExceptionally(stopping.getAsBoolean() && !(c instanceof ArchitectRefused) ? stopped("the world stopped (" + c.getMessage() + ")") : c);
		});
		return out;
	}

	/** SERVER_STOPPING: fails every pending API future with WORLD_STOPPED. */
	public static int stop() {
		List<CompletableFuture<?>> all = List.copyOf(PENDING);
		PENDING.clear();
		int n = 0;
		for (CompletableFuture<?> f : all) {
			if (f.completeExceptionally(stopped("the world stopped while this was pending"))) {
				n++;
			}
		}
		if (n > 0) {
			Architect.LOGGER.info("API: {} pending future(s) failed with WORLD_STOPPED", n);
		}
		return n;
	}

	/** How many API futures are pending (tests, DevBridge). */
	public static int pending() {
		return PENDING.size();
	}

	/**
	 * {@code impl} behind a proxy of {@code iface}: its futures are tracked; with {@code needsWorld} and no world running (or the
	 * world stopping), a call returning a future fails at once with WORLD_STOPPED.
	 */
	@SuppressWarnings("unchecked")
	public static <T> T wrap(Class<T> iface, T impl, boolean needsWorld) {
		InvocationHandler h = (proxy, m, args) -> {
			if (m.getDeclaringClass() == Object.class) {
				return switch (m.getName()) {
					case "equals" -> proxy == args[0];
					case "hashCode" -> System.identityHashCode(proxy);
					default -> m.invoke(impl, args);
				};
			}
			boolean future = CompletableFuture.class.isAssignableFrom(m.getReturnType());
			if (future && needsWorld && (ApiImpl.server() == null || stopping.getAsBoolean())) {
				return CompletableFuture.failedFuture(stopped("no world is running"));
			}
			Object r;
			try {
				r = m.invoke(impl, args);
			} catch (InvocationTargetException e) {
				throw e.getCause();
			}
			return future && r instanceof CompletableFuture<?> f ? track(f) : r;
		};
		return (T) Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[] {iface}, h);
	}
}

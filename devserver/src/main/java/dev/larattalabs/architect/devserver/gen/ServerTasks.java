package dev.larattalabs.architect.devserver.gen;

import dev.larattalabs.architect.devserver.Bot;
import dev.larattalabs.architect.devserver.DevServer;
import java.util.concurrent.CompletableFuture;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Function;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

/**
 * The headless counterpart of the client's {@code ServerTasks}: the same calls, on the dedicated server, with the bot as
 * "the player". Futures complete on the server thread (the client's complete on the client thread; the hooks only chain on
 * them).
 */
public final class ServerTasks {
	private ServerTasks() {
	}

	/** Thrown by {@link #callAsPlayer} work for a refusal meant for the player (the message is shown as is). */
	public static final class Refused extends RuntimeException {
		public Refused(String message) {
			super(message, null, false, false);
		}
	}

	static MinecraftServer needServer() {
		MinecraftServer s = DevServer.server();
		if (s == null) {
			throw new Refused("the headless server is not running a world");
		}
		return s;
	}

	public static boolean run(Consumer<ServerLevel> task) {
		MinecraftServer s = DevServer.server();
		if (s == null) {
			return false;
		}
		s.execute(() -> task.accept(s.overworld()));
		return true;
	}

	public static <T> CompletableFuture<T> callOnServer(Function<MinecraftServer, T> work) {
		MinecraftServer s;
		try {
			s = needServer();
		} catch (Refused e) {
			return CompletableFuture.failedFuture(e);
		}
		CompletableFuture<T> f = new CompletableFuture<>();
		s.execute(() -> {
			try {
				f.complete(work.apply(s));
			} catch (Throwable t) {
				f.completeExceptionally(t);
			}
		});
		return f;
	}

	/** {@code work} on the server thread with the bot's level and the bot; fails with {@link Refused} when there is no bot. */
	public static <T> CompletableFuture<T> callAsPlayer(BiFunction<ServerLevel, ServerPlayer, T> work) {
		MinecraftServer s;
		try {
			s = needServer();
		} catch (Refused e) {
			return CompletableFuture.failedFuture(e);
		}
		CompletableFuture<T> f = new CompletableFuture<>();
		s.execute(() -> {
			try {
				ServerPlayer p = Bot.player(s);
				if (p == null) {
					throw new Refused("The player is not on the server (yet)");
				}
				f.complete(work.apply(p.level(), p));
			} catch (Throwable t) {
				f.completeExceptionally(t);
			}
		});
		return f;
	}
}

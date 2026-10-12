package dev.larattalabs.architect.devserver;

import com.mojang.authlib.GameProfile;
import dev.larattalabs.architect.Architect;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.embedded.EmbeddedChannel;
import java.lang.reflect.Field;
import java.util.UUID;
import net.minecraft.core.UUIDUtil;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.common.ServerboundKeepAlivePacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ParticleStatus;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.config.PrepareSpawnTask;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.players.NameAndId;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.player.ChatVisiblity;
import org.jspecify.annotations.Nullable;

/**
 * The headless gates' player: a real {@link ServerPlayer} joined through {@code PlayerList.placeNewPlayer} with a connection
 * that goes nowhere (as carpet's bots do). It is in {@code getPlayers()}, loads and tickets chunks around itself like a
 * client's player (view distance 16, the dev client's render distance), stands in boxes (occupancy, the PLAYER blocker), runs
 * commands as {@code @s}, and is saved to and loaded from the world's {@code playerdata} like any player. Its name is the
 * dev client's (ARCHITECT_PLAYER, else the OS user), so its offline UUID, and so the site ownership in the gate worlds, is
 * the same. It is an operator (commands at full permission come from the DevBridge's dev.command anyway).
 */
public final class Bot {
	/** The dev client's render distance (mod/run-template/options.txt); the server's view distance is the same. */
	static final int VIEW_DISTANCE = intEnv("ARCHITECT_BOT_VIEW_DISTANCE", 16);
	private static volatile @Nullable UUID uuid;

	public static int viewDistance() {
		return VIEW_DISTANCE;
	}

	private Bot() {
	}

	public static int intEnv(String k, int def) {
		try {
			String v = System.getenv(k);
			return v == null || v.isBlank() ? def : Integer.parseInt(v.strip());
		} catch (NumberFormatException e) {
			return def;
		}
	}

	/** The dev client's player name: ARCHITECT_PLAYER, else the OS user name; [A-Za-z0-9_], at most 16. */
	static String name() {
		String n = System.getenv("ARCHITECT_PLAYER");
		if (n == null || n.isBlank()) {
			n = System.getProperty("user.name", "Player");
		}
		n = n.replaceAll("[^A-Za-z0-9_]", "");
		if (n.length() > 16) {
			n = n.substring(0, 16);
		}
		return n.isEmpty() ? "Player" : n;
	}

	/** The bot on this server, or null (server thread). */
	public static @Nullable ServerPlayer player(MinecraftServer server) {
		UUID u = uuid;
		return u == null ? null : server.getPlayerList().getPlayer(u);
	}

	/**
	 * Joins the bot the way a client's login does (server thread): vanilla's PrepareSpawnTask finds its saved position (or the
	 * world spawn), loads the chunks there, and then constructs, positions and places the player. Ticked from the server's
	 * end-of-tick until it is ready.
	 */
	static void spawn(MinecraftServer server) {
		String name = name();
		GameProfile profile = new GameProfile(UUIDUtil.createOfflinePlayerUUID(name), name);
		ClientInformation info = new ClientInformation("en_us", VIEW_DISTANCE, ChatVisiblity.FULL, true, 0x7f, HumanoidArm.RIGHT, false, true,
			ParticleStatus.MINIMAL);
		NameAndId id = new NameAndId(profile);
		server.getPlayerList().op(id);
		PrepareSpawnTask task = new PrepareSpawnTask(server, id);
		task.start(packet -> {
		});
		DevServer.everyTick(s -> {
			if (!task.tick()) {
				return false;
			}
			ServerPlayer p = task.spawnPlayer(new NoConnection(), new CommonListenerCookie(profile, 0, info, false));
			uuid = profile.id();
			Architect.LOGGER.info("devserver: bot {} ({}) joined at {} {} {} in {}", name, profile.id(), p.getX(), p.getY(), p.getZ(),
				p.level().dimension().identifier());
			return true;
		});
	}

	private static Field keepAlivePending;
	private static Field keepAliveChallenge;

	/** Answers the server's keep-alive for the bot, so it is never timed out (end of each server tick). */
	static void tick(MinecraftServer server) {
		ServerPlayer p = player(server);
		if (p == null || p.connection == null) {
			return;
		}
		try {
			if (keepAlivePending == null) {
				keepAlivePending = ServerCommonPacketListenerImpl.class.getDeclaredField("keepAlivePending");
				keepAliveChallenge = ServerCommonPacketListenerImpl.class.getDeclaredField("keepAliveChallenge");
				keepAlivePending.setAccessible(true);
				keepAliveChallenge.setAccessible(true);
			}
			if (keepAlivePending.getBoolean(p.connection)) {
				p.connection.handleKeepAlive(new ServerboundKeepAlivePacket(keepAliveChallenge.getLong(p.connection)));
			}
		} catch (ReflectiveOperationException e) {
			throw new IllegalStateException("devserver: the bot's keep-alive fields moved", e);
		}
	}

	/**
	 * A connection with no client (an embedded channel, as carpet's bots use): the protocol setup runs as usual, every packet
	 * to the client is dropped, so nothing queues up.
	 */
	static final class NoConnection extends Connection {
		NoConnection() {
			super(PacketFlow.SERVERBOUND);
			try {
				Field ch = Connection.class.getDeclaredField("channel");
				ch.setAccessible(true);
				ch.set(this, new EmbeddedChannel());
			} catch (ReflectiveOperationException e) {
				throw new IllegalStateException("devserver: Connection.channel moved", e);
			}
		}

		@Override
		public void send(Packet<?> packet) {
		}

		@Override
		public void send(Packet<?> packet, @Nullable ChannelFutureListener listener) {
		}

		@Override
		public void send(Packet<?> packet, @Nullable ChannelFutureListener listener, boolean flush) {
		}

		@Override
		public void flushChannel() {
		}
	}
}

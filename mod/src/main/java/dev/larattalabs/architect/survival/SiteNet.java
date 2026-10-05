package dev.larattalabs.architect.survival;

import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/**
 * The construction-site payloads (docs/CONTRACT.md phase 3 "Ghost"), server to client:
 * <ul>
 * <li>{@code architect_mc:site_ghost}: once when a client comes in range or joins (and again when cells were lost: a built
 * cell mined while building): the site, its box origin and size, the queue (box indexes in build order, delta varints),
 * each queued cell's block state id (what it will be), and the {@code built} bitset over the queue.</li>
 * <li>{@code architect_mc:site_progress}: the queue indexes built since the last tick (batched per tick).</li>
 * <li>{@code architect_mc:site_status} (addition): once a second, the HUD line and the green tint's input: progress, what the
 * site needs most, which items the crate holds, paused, blocked cells, the owner, crate missing.</li>
 * <li>{@code architect_mc:site_clear} (addition): the site left the client's range, was built ({@code finished}: toast), or
 * removed.</li>
 * <li>{@code architect_mc:crate_open} (addition): open the crate screen for a site (right-click on its crate).</li>
 * </ul>
 * The contract's ghost payload carries the blueprint id so the client could derive the cells from the template; here it also
 * carries the cells themselves, because the foundation and approach cells depend on the terrain at the spot, which the
 * client can't recompute exactly.
 */
public final class SiteNet {
	private SiteNet() {
	}

	public record SiteGhost(String siteId, String blueprintId, String rotation, String name, int ox, int oy, int oz, int dx, int dy, int dz,
		byte[] queue, int[] stateIds, long[] built) implements CustomPacketPayload {
		public static final Type<SiteGhost> TYPE = new Type<>(Architect.id("site_ghost"));
		public static final StreamCodec<RegistryFriendlyByteBuf, SiteGhost> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.siteId);
			buf.writeUtf(p.blueprintId);
			buf.writeUtf(p.rotation);
			buf.writeUtf(p.name);
			buf.writeVarInt(p.ox);
			buf.writeVarInt(p.oy);
			buf.writeVarInt(p.oz);
			buf.writeVarInt(p.dx);
			buf.writeVarInt(p.dy);
			buf.writeVarInt(p.dz);
			buf.writeByteArray(p.queue);
			buf.writeVarIntArray(p.stateIds);
			buf.writeLongArray(p.built);
		}, buf -> new SiteGhost(buf.readUtf(), buf.readUtf(), buf.readUtf(), buf.readUtf(), buf.readVarInt(), buf.readVarInt(), buf.readVarInt(),
			buf.readVarInt(), buf.readVarInt(), buf.readVarInt(), buf.readByteArray(), buf.readVarIntArray(), buf.readLongArray()));

		@Override
		public Type<SiteGhost> type() {
			return TYPE;
		}
	}

	public record SiteProgress(String siteId, byte[] newlyBuilt) implements CustomPacketPayload {
		public static final Type<SiteProgress> TYPE = new Type<>(Architect.id("site_progress"));
		public static final StreamCodec<RegistryFriendlyByteBuf, SiteProgress> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.siteId);
			buf.writeByteArray(p.newlyBuilt);
		}, buf -> new SiteProgress(buf.readUtf(), buf.readByteArray()));

		@Override
		public Type<SiteProgress> type() {
			return TYPE;
		}
	}

	public record SiteStatus(String siteId, String name, int built, int total, String needs, boolean paused, int blocked, List<String> available,
		String owner, boolean crateMissing, int cx, int cy, int cz) implements CustomPacketPayload {
		public static final Type<SiteStatus> TYPE = new Type<>(Architect.id("site_status"));
		public static final StreamCodec<RegistryFriendlyByteBuf, SiteStatus> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.siteId);
			buf.writeUtf(p.name);
			buf.writeVarInt(p.built);
			buf.writeVarInt(p.total);
			buf.writeUtf(p.needs);
			buf.writeBoolean(p.paused);
			buf.writeVarInt(p.blocked);
			buf.writeVarInt(p.available.size());
			p.available.forEach(buf::writeUtf);
			buf.writeUtf(p.owner);
			buf.writeBoolean(p.crateMissing);
			buf.writeVarInt(p.cx);
			buf.writeVarInt(p.cy);
			buf.writeVarInt(p.cz);
		}, buf -> {
			String id = buf.readUtf();
			String name = buf.readUtf();
			int built = buf.readVarInt();
			int total = buf.readVarInt();
			String needs = buf.readUtf();
			boolean paused = buf.readBoolean();
			int blocked = buf.readVarInt();
			int n = buf.readVarInt();
			List<String> avail = new ArrayList<>(n);
			for (int i = 0; i < n; i++) {
				avail.add(buf.readUtf());
			}
			return new SiteStatus(id, name, built, total, needs, paused, blocked, List.copyOf(avail), buf.readUtf(), buf.readBoolean(), buf.readVarInt(),
				buf.readVarInt(), buf.readVarInt());
		});

		@Override
		public Type<SiteStatus> type() {
			return TYPE;
		}
	}

	public record SiteClear(String siteId, boolean finished, String name) implements CustomPacketPayload {
		public static final Type<SiteClear> TYPE = new Type<>(Architect.id("site_clear"));
		public static final StreamCodec<RegistryFriendlyByteBuf, SiteClear> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.siteId);
			buf.writeBoolean(p.finished);
			buf.writeUtf(p.name);
		}, buf -> new SiteClear(buf.readUtf(), buf.readBoolean(), buf.readUtf()));

		@Override
		public Type<SiteClear> type() {
			return TYPE;
		}
	}

	public record CrateOpen(String siteId) implements CustomPacketPayload {
		public static final Type<CrateOpen> TYPE = new Type<>(Architect.id("crate_open"));
		public static final StreamCodec<RegistryFriendlyByteBuf, CrateOpen> CODEC = StreamCodec.of((buf, p) -> buf.writeUtf(p.siteId),
			buf -> new CrateOpen(buf.readUtf()));

		@Override
		public Type<CrateOpen> type() {
			return TYPE;
		}
	}

	/** Registers the payload types (both sides, at mod init). */
	public static void init() {
		PayloadTypeRegistry<RegistryFriendlyByteBuf> s2c = PayloadTypeRegistry.clientboundPlay();
		s2c.registerLarge(SiteGhost.TYPE, SiteGhost.CODEC, 16 * 1024 * 1024);
		s2c.register(SiteProgress.TYPE, SiteProgress.CODEC);
		s2c.register(SiteStatus.TYPE, SiteStatus.CODEC);
		s2c.register(SiteClear.TYPE, SiteClear.CODEC);
		s2c.register(CrateOpen.TYPE, CrateOpen.CODEC);
	}
}

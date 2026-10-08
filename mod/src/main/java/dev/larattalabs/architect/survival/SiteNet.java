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
	/**
	 * Phase 4e {@code architect_mc:road_cells}: standing roads' surface and slab cells near a player, per chunk section (12-bit
	 * positions, a top byte: 0 surface, 1 slab), so the client's approach adapter draws an approach that stops at a road. A
	 * section listed with no cells has none any more (a delta).
	 */
	public record RoadCells(String dimension, long[] keys, List<int[]> cells, List<byte[]> top) implements CustomPacketPayload {
		public static final Type<RoadCells> TYPE = new Type<>(Architect.id("road_cells"));
		public static final StreamCodec<RegistryFriendlyByteBuf, RoadCells> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.dimension);
			buf.writeVarInt(p.keys.length);
			for (int i = 0; i < p.keys.length; i++) {
				buf.writeLong(p.keys[i]);
				buf.writeVarIntArray(p.cells.get(i));
				buf.writeByteArray(p.top.get(i));
			}
		}, buf -> {
			String dim = buf.readUtf();
			int n = buf.readVarInt();
			long[] keys = new long[n];
			List<int[]> cells = new ArrayList<>(n);
			List<byte[]> top = new ArrayList<>(n);
			for (int i = 0; i < n; i++) {
				keys[i] = buf.readLong();
				cells.add(buf.readVarIntArray());
				top.add(buf.readByteArray());
			}
			return new RoadCells(dim, keys, cells, top);
		});

		@Override
		public Type<RoadCells> type() {
			return TYPE;
		}
	}

	/**
	 * A delta ghost (phase 5b, {@code architect_mc:delta_preview}): the composite key it goes under, the site, the version it goes
	 * to, and its cells section-packed as {@link RoadCells} (12-bit positions within each section) with a kind per cell (0 added,
	 * 1 removed, 2 changed, 3 kept). Up to 200k cells. An empty section list clears the key.
	 */
	public record DeltaPreview(String key, String siteId, int to, long[] keys, List<int[]> cells, List<byte[]> kinds) implements CustomPacketPayload {
		public static final Type<DeltaPreview> TYPE = new Type<>(Architect.id("delta_preview"));
		public static final StreamCodec<RegistryFriendlyByteBuf, DeltaPreview> CODEC = StreamCodec.of((buf, p) -> {
			buf.writeUtf(p.key);
			buf.writeUtf(p.siteId);
			buf.writeVarInt(p.to);
			buf.writeVarInt(p.keys.length);
			for (int i = 0; i < p.keys.length; i++) {
				buf.writeLong(p.keys[i]);
				buf.writeVarIntArray(p.cells.get(i));
				buf.writeByteArray(p.kinds.get(i));
			}
		}, buf -> {
			String key = buf.readUtf();
			String site = buf.readUtf();
			int to = buf.readVarInt();
			int n = buf.readVarInt();
			long[] keys = new long[n];
			List<int[]> cells = new ArrayList<>(n);
			List<byte[]> kinds = new ArrayList<>(n);
			for (int i = 0; i < n; i++) {
				keys[i] = buf.readLong();
				cells.add(buf.readVarIntArray());
				kinds.add(buf.readByteArray());
			}
			return new DeltaPreview(key, site, to, keys, cells, kinds);
		});

		@Override
		public Type<DeltaPreview> type() {
			return TYPE;
		}

		/** From world cells (packed positions) and their kinds. */
		public static DeltaPreview of(String key, String siteId, int to, java.util.Map<Long, Byte> ghost) {
			java.util.TreeMap<Long, List<long[]>> by = new java.util.TreeMap<>();
			for (var e : ghost.entrySet()) {
				long p = e.getKey();
				by.computeIfAbsent(dev.larattalabs.architect.journal.Sections.key(p), k -> new ArrayList<>()).add(new long[] {p, e.getValue()});
			}
			long[] keys = new long[by.size()];
			List<int[]> cells = new ArrayList<>();
			List<byte[]> kinds = new ArrayList<>();
			int i = 0;
			for (var e : by.entrySet()) {
				keys[i++] = e.getKey();
				int[] c = new int[e.getValue().size()];
				byte[] k = new byte[c.length];
				for (int j = 0; j < c.length; j++) {
					c[j] = dev.larattalabs.architect.journal.Sections.index(e.getValue().get(j)[0]);
					k[j] = (byte) e.getValue().get(j)[1];
				}
				cells.add(c);
				kinds.add(k);
			}
			return new DeltaPreview(key, siteId, to, keys, cells, kinds);
		}
	}

	public static void init() {
		PayloadTypeRegistry<RegistryFriendlyByteBuf> s2c = PayloadTypeRegistry.clientboundPlay();
		s2c.registerLarge(DeltaPreview.TYPE, DeltaPreview.CODEC, 16 * 1024 * 1024);
		s2c.registerLarge(RoadCells.TYPE, RoadCells.CODEC, 16 * 1024 * 1024);
		s2c.registerLarge(SiteGhost.TYPE, SiteGhost.CODEC, 16 * 1024 * 1024);
		s2c.register(SiteProgress.TYPE, SiteProgress.CODEC);
		s2c.register(SiteStatus.TYPE, SiteStatus.CODEC);
		s2c.register(SiteClear.TYPE, SiteClear.CODEC);
		s2c.register(CrateOpen.TYPE, CrateOpen.CODEC);
	}
}

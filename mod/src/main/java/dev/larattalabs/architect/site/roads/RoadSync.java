package dev.larattalabs.architect.site.roads;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.SiteNet;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityLevelChangeEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * Road cells to clients (docs/CONTRACT.md phase 4e "Approaches meet roads", client ghost): the client has no journal, so the
 * server sends the standing roads' surface and slab cells in sections within {@link #RANGE} blocks of each player, on join
 * and dimension change, and the sections a road changed when one is placed or removed.
 */
public final class RoadSync {
	public static final int RANGE = 160;

	private RoadSync() {
	}

	public static void init() {
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> server.execute(() -> sendNear(handler.getPlayer())));
		ServerEntityLevelChangeEvents.AFTER_PLAYER_CHANGE_LEVEL.register((player, from, to) -> sendNear(player));
	}

	/** Every road section within range of {@code p}. */
	public static void sendNear(ServerPlayer p) {
		String dim = p.level().dimension().identifier().toString();
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return;
		}
		int sx = p.getBlockX() >> 4;
		int sz = p.getBlockZ() >> 4;
		int r = RANGE >> 4;
		Set<Long> keys = new TreeSet<>();
		for (long k : js.sectionsOf(dim)) {
			if (Math.abs(Sections.sx(k) - sx) <= r && Math.abs(Sections.sz(k) - sz) <= r && hasRoad(js, dim, k)) {
				keys.add(k);
			}
		}
		if (!keys.isEmpty()) {
			send(p, payload(js, dim, keys));
		}
	}

	/** A road was placed or removed over {@code box}: its sections, to every player in range. */
	public static void changed(MinecraftServer server, String dim, Anchors.Bounds box) {
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return;
		}
		Set<Long> keys = WorldJournal.sectionsOf(box);
		SiteNet.RoadCells pl = payload(js, dim, keys);
		for (ServerPlayer p : server.getPlayerList().getPlayers()) {
			if (!p.level().dimension().identifier().toString().equals(dim)) {
				continue;
			}
			double dx = Math.max(box.minX() - p.getX(), Math.max(0, p.getX() - box.maxX()));
			double dz = Math.max(box.minZ() - p.getZ(), Math.max(0, p.getZ() - box.maxZ()));
			if (dx * dx + dz * dz <= (double) RANGE * RANGE) {
				send(p, pl);
			}
		}
	}

	private static boolean hasRoad(JournalStore js, String dim, long k) {
		for (String id : js.inSection(dim, k)) {
			JournalStore.Meta m = js.meta(id);
			if (m != null && m.active() && m.kind().equals(WorldJournal.ROAD)) {
				return true;
			}
		}
		return false;
	}

	private static SiteNet.RoadCells payload(JournalStore js, String dim, Set<Long> keys) {
		long[] ks = new long[keys.size()];
		List<int[]> cells = new ArrayList<>();
		List<byte[]> top = new ArrayList<>();
		int i = 0;
		for (long k : keys) {
			ks[i++] = k;
			List<Integer> c = new ArrayList<>();
			List<Byte> t = new ArrayList<>();
			for (String id : js.inSection(dim, k)) {
				JournalStore.Meta m = js.meta(id);
				if (m == null || !m.active() || !m.kind().equals(WorldJournal.ROAD)) {
					continue;
				}
				try {
					SectionCells sc = js.section(id, k);
					if (sc == null) {
						continue;
					}
					for (int j = 0; j < sc.size(); j++) {
						Journal.Value a = sc.after(j);
						if (a == null) {
							continue;
						}
						String n = a.name();
						if (n.equals("minecraft:air") || n.equals("minecraft:oak_fence") || n.equals("minecraft:lantern")) {
							continue;
						}
						c.add(sc.index(j));
						t.add((byte) (n.endsWith("_slab") ? 1 : 0));
					}
				} catch (IOException e) {
					// unreadable: not sent
				}
			}
			cells.add(c.stream().mapToInt(Integer::intValue).toArray());
			byte[] b = new byte[t.size()];
			for (int j = 0; j < b.length; j++) {
				b[j] = t.get(j);
			}
			top.add(b);
		}
		return new SiteNet.RoadCells(dim, ks, cells, top);
	}

	private static void send(ServerPlayer p, SiteNet.RoadCells pl) {
		if (ServerPlayNetworking.canSend(p, pl.type())) {
			ServerPlayNetworking.send(p, pl);
		}
	}
}

package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.CellWrite;
import dev.larattalabs.architect.api.CellsRequest;
import dev.larattalabs.architect.api.RoadRequest;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.TagParser;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/** A queued road or cell-site item's request as JSON (the queue file; cells packed: positions as base64 longs, a state palette). */
final class InfraSpec {
	private InfraSpec() {
	}

	static JsonObject road(RoadRequest r) {
		JsonObject o = new JsonObject();
		JsonArray pts = new JsonArray();
		for (BlockPos p : r.points()) {
			JsonArray a = new JsonArray();
			a.add(p.getX());
			a.add(p.getY());
			a.add(p.getZ());
			pts.add(a);
		}
		o.add("points", pts);
		o.addProperty("width", r.width());
		if (r.surface() != null) {
			o.addProperty("surface", r.surface());
		}
		if (r.slab() != null) {
			o.addProperty("slab", r.slab());
		}
		o.addProperty("lanterns", r.lanterns());
		o.addProperty("shallowDecks", r.shallowDecks());
		o.addProperty("force", r.force());
		if (r.partial()) {
			o.addProperty("partial", true); // 6c 0c §3
		}
		return o;
	}

	static List<BlockPos> points(JsonObject o) {
		List<BlockPos> out = new ArrayList<>();
		o.getAsJsonArray("points").forEach(e -> {
			JsonArray a = e.getAsJsonArray();
			out.add(new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
		});
		return out;
	}

	static @Nullable String str(JsonObject o, String k) {
		return o.has(k) ? o.get(k).getAsString() : null;
	}

	static JsonObject cells(CellsRequest r) {
		JsonObject o = new JsonObject();
		o.addProperty("kind", r.kind());
		o.addProperty("policy", r.policy().name());
		o.addProperty("naturalOnly", r.naturalOnly());
		o.addProperty("force", r.force());
		Map<BlockState, Integer> pal = new HashMap<>();
		JsonArray palette = new JsonArray();
		ByteBuffer pos = ByteBuffer.allocate(r.cells().size() * 8);
		ByteBuffer idx = ByteBuffer.allocate(r.cells().size() * 4);
		JsonObject nbt = new JsonObject();
		int i = 0;
		for (CellWrite c : r.cells()) {
			pos.putLong(c.pos().asLong());
			Integer k = pal.get(c.state());
			if (k == null) {
				k = pal.size();
				pal.put(c.state(), k);
				palette.add(NbtUtils.writeBlockState(c.state()).toString());
			}
			idx.putInt(k);
			if (c.nbt() != null) {
				nbt.addProperty(Integer.toString(i), c.nbt().toString());
			}
			i++;
		}
		o.add("palette", palette);
		if (r.cells().stream().anyMatch(c -> c.cond() != null)) {
			byte[] cond = new byte[r.cells().size()];
			int k = 0;
			for (CellWrite c : r.cells()) {
				cond[k++] = (byte) (c.cond() == null ? -1 : c.cond().ordinal());
			}
			o.addProperty("cond", Base64.getEncoder().encodeToString(cond)); // phase 6a: CellWrite.Cond, -1 = none
		}
		o.addProperty("pos", Base64.getEncoder().encodeToString(pos.array()));
		o.addProperty("idx", Base64.getEncoder().encodeToString(idx.array()));
		if (nbt.size() > 0) {
			o.add("nbt", nbt);
		}
		return o;
	}

	/** The cells of {@link #cells}: positions, states and block entity data. */
	record Cells(List<BlockPos> pos, List<BlockState> states, List<@Nullable CompoundTag> nbt, byte @Nullable [] cond) {
	}

	static Cells cellsOf(JsonObject o) {
		List<BlockState> pal = new ArrayList<>();
		o.getAsJsonArray("palette").forEach(e -> {
			try {
				pal.add(NbtUtils.readBlockState(BuiltInRegistries.BLOCK, TagParser.parseCompoundFully(e.getAsString())));
			} catch (Exception ex) {
				throw new IllegalArgumentException("bad state " + e, ex);
			}
		});
		ByteBuffer pos = ByteBuffer.wrap(Base64.getDecoder().decode(o.get("pos").getAsString()));
		ByteBuffer idx = ByteBuffer.wrap(Base64.getDecoder().decode(o.get("idx").getAsString()));
		int n = pos.capacity() / 8;
		List<BlockPos> ps = new ArrayList<>(n);
		List<BlockState> ss = new ArrayList<>(n);
		List<CompoundTag> ns = new ArrayList<>(n);
		JsonObject nbt = o.has("nbt") ? o.getAsJsonObject("nbt") : new JsonObject();
		for (int i = 0; i < n; i++) {
			ps.add(BlockPos.of(pos.getLong()));
			ss.add(pal.get(idx.getInt()));
			CompoundTag t = null;
			if (nbt.has(Integer.toString(i))) {
				try {
					t = TagParser.parseCompoundFully(nbt.get(Integer.toString(i)).getAsString());
				} catch (Exception ex) {
					t = null;
				}
			}
			ns.add(t);
		}
		return new Cells(ps, ss, ns, o.has("cond") ? Base64.getDecoder().decode(o.get("cond").getAsString()) : null);
	}
}

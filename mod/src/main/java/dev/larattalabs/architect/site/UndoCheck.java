package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.io.IOException;
import java.util.Collection;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;

/**
 * Gate 6a item 6 (DevBridge {@code dev.undo.mark} / {@code dev.undo.check}): "one stage's undo and one lot's undo are exact on
 * the cells they own". Mark records, for every cell the sites' active entries own (leaves entries too), the value the entry
 * restores (its bottom-most {@code before} per position); check compares the world to them after the undo.
 */
public final class UndoCheck {
	private static final Long2ObjectOpenHashMap<Journal.Value> MARKED = new Long2ObjectOpenHashMap<>();

	private UndoCheck() {
	}

	public static JsonObject mark(Collection<String> sites) throws IOException {
		MARKED.clear();
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			throw new IOException("the journal is unavailable");
		}
		it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap layer = new it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap();
		for (String s : sites) {
			for (JournalStore.Meta m : SiteJournal.entries(s)) {
				if (!m.active()) {
					continue;
				}
				for (long k : m.sections()) {
					SectionCells sc = js.section(m.id(), k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						long p = sc.pos(i);
						Journal.Cell c = sc.cell(i);
						// several of the marked entries on one cell: the lowest layer's before is what the undo gives back
						if (!MARKED.containsKey(p) || c.layer() < layer.get(p)) {
							MARKED.put(p, sc.before(i));
							layer.put(p, c.layer());
						}
					}
				}
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("cells", MARKED.size());
		return o;
	}

	public static JsonObject check(ServerLevel level) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		int bad = 0;
		JsonArray list = new JsonArray();
		for (var e : MARKED.long2ObjectEntrySet()) {
			long p = e.getLongKey();
			Journal.Value now = WorldJournal.valueAt(level, m.set(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)));
			if (!now.equals(e.getValue())) {
				bad++;
				if (list.size() < 50) {
					list.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p) + " want " + e.getValue().name() + " now " + now.name());
				}
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("cells", MARKED.size());
		o.addProperty("mismatches", bad);
		o.add("first", list);
		return o;
	}
}

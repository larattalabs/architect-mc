package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import org.junit.jupiter.api.Test;

/**
 * Slice PT2 gate item 13 (recorded), copied by tools/gate6cpt2.mjs into a v0.27.0 worktree and run there with 0.27.0's own classes
 * (never committed to that tag): what a 0.27.0 reader does with a PT2 world's journal. For each journal (PT2_JOURNALS, path-separated
 * {@code architect-journal} folders) it reads the index with 0.27.0's {@code JournalStore.indexFromJson} and every entry file with
 * 0.27.0's {@code JournalNbt.decode} / {@code decodeHead}, and writes the counts to PT2_REPORT.
 */
class Pt2Old027ReadTest {
	@Test
	void read() throws Exception {
		List<String> lines = new ArrayList<>();
		int adoptRefused = 0, adoptRead = 0, otherRead = 0, otherRefused = 0, indexKeptAdopt = 0;
		for (String j : System.getenv().getOrDefault("PT2_JOURNALS", "").split(java.io.File.pathSeparator)) {
			if (j.isEmpty()) {
				continue;
			}
			Path dir = Path.of(j);
			JsonObject o = JsonParser.parseString(Files.readString(dir.resolve("journal.json"), StandardCharsets.UTF_8)).getAsJsonObject();
			JournalStore.Index idx = JournalStore.indexFromJson(o);
			for (JournalStore.Meta m : idx.entries().values()) {
				boolean adopt = "adopt".equals(m.kind());
				if (adopt) {
					indexKeptAdopt++;
				}
				Path ed = dir.resolve("e").resolve(m.id());
				if (!Files.isDirectory(ed)) {
					continue;
				}
				try (var fs = Files.list(ed)) {
					for (Path f : fs.sorted().toList()) {
						if (!f.toString().endsWith(".nbt")) {
							continue;
						}
						CompoundTag t = NbtIo.readCompressed(f, NbtAccounter.unlimitedHeap());
						boolean ok;
						String why = "";
						try {
							if (f.getFileName().toString().startsWith("head.")) {
								JournalNbt.decodeHead(t);
							} else {
								JournalNbt.decode(t, m.layer());
							}
							ok = true;
						} catch (IllegalArgumentException e) {
							ok = false;
							why = e.getMessage();
						}
						if (adopt && ok) {
							adoptRead++;
						} else if (adopt) {
							adoptRefused++;
						} else if (ok) {
							otherRead++;
						} else {
							otherRefused++;
						}
						lines.add((ok ? "read    " : "REFUSED ") + m.kind() + " " + m.id() + " " + f.getFileName() + " v" + t.getIntOr("version", 0) + (ok ? "" : " (" + why + ")"));
					}
				}
			}
		}
		StringBuilder sb = new StringBuilder();
		sb.append("adoptRefused ").append(adoptRefused).append('\n');
		sb.append("adoptRead ").append(adoptRead).append('\n');
		sb.append("otherRead ").append(otherRead).append('\n');
		sb.append("otherRefused ").append(otherRefused).append('\n');
		sb.append("indexKeptAdopt ").append(indexKeptAdopt).append('\n');
		lines.forEach(l -> sb.append(l).append('\n'));
		String report = System.getenv("PT2_REPORT");
		if (report != null) {
			Files.writeString(Path.of(report), sb.toString(), StandardCharsets.UTF_8);
		}
		assertTrue(adoptRead == 0 && otherRefused == 0, sb.toString());
	}
}

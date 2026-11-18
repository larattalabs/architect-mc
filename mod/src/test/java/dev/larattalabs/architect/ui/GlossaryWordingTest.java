package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.client.help.ArchitectGlossary;
import dev.larattalabs.labui.ui.Glossary;
import dev.larattalabs.labui.ui.WordingLint;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * (PR G1) The wording rule over every opted-in mod's player-facing strings: its lang file and the sentence-like string literals of its
 * client and command code (dev hooks, logs and exceptions for developers skipped). Architect is always in; a second mod joins by a
 * {@link Root} here, enabled once it opts in (Steward: {@code -Dwording.steward=true} with ../steward-mc checked out; S-PR-3).
 */
class GlossaryWordingTest {
	record Root(String name, Path lang, List<Path> sources) {
	}

	/** Developer-only lines: DevBridge hook descriptions, logs, dev exceptions. */
	static final Pattern SKIP = Pattern.compile("DevBridge\\.register|LOGGER\\.|DevException|IllegalStateException|IllegalArgumentException|"
		+ "addProperty\\(");

	static List<Root> roots() {
		Path mod = Path.of("").toAbsolutePath(); // the test task runs in mod/
		List<Root> out = new ArrayList<>();
		out.add(new Root("architect_mc", mod.resolve("src/main/resources/assets/architect_mc/lang/en_us.json"),
			List.of(mod.resolve("src/client/java"), mod.resolve("src/main/java"))));
		Path steward = mod.resolve("../../steward-mc");
		if (Boolean.getBoolean("wording.steward") && Files.isDirectory(steward)) {
			out.add(new Root("steward_mc", steward.resolve("mod/src/main/resources/assets/steward_mc/lang/en_us.json"),
				List.of(steward.resolve("mod/src/client/java"), steward.resolve("mod/src/main/java"))));
		}
		return out;
	}

	static List<WordingLint.Hit> scan(Root r) throws IOException {
		List<WordingLint.Hit> hits = new ArrayList<>();
		if (Files.exists(r.lang())) {
			JsonObject o = JsonParser.parseString(Files.readString(r.lang(), StandardCharsets.UTF_8)).getAsJsonObject();
			Map<String, String> m = new LinkedHashMap<>();
			o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsString()));
			hits.addAll(WordingLint.lang(m));
		}
		for (Path dir : r.sources()) {
			if (!Files.isDirectory(dir)) {
				continue;
			}
			try (Stream<Path> files = Files.walk(dir)) {
				for (Path f : files.filter(p -> p.toString().endsWith(".java") && !p.toString().contains("/dev/larattalabs/architect/client/dev/")).toList()) {
					hits.addAll(WordingLint.source(dir.relativize(f).toString(), Files.readAllLines(f, StandardCharsets.UTF_8), SKIP));
				}
			}
		}
		return hits;
	}

	@Test
	void noPlayerTextSaysBlueprint() throws IOException {
		for (Root r : roots()) {
			assertTrue(Files.exists(r.lang()) && Files.isDirectory(r.sources().get(0)), r.name() + ": its strings are not where the test looks");
			List<WordingLint.Hit> hits = scan(r);
			assertTrue(hits.isEmpty(), r.name() + ": " + hits);
		}
	}

	@Test
	void theScanSeesMainsOldHit() {
		// main's Reconcile line said "does not match its blueprint": the scan finds a line like it
		List<WordingLint.Hit> h = WordingLint.source("Reconcile.java", List.of("return id + \" does not match its blueprint (\" + pct;"), SKIP);
		assertEquals(1, h.size());
	}

	@Test
	void theGlossaryCoversTheContractTerms() {
		for (String w : List.of("design", "Style", "parts", "variant", "set", "collection", "site", "construction site", "build", "crate", "stockpile",
			"design helper", "ghost", "plot", "region", "lot", "connector or link")) {
			assertTrue(ArchitectGlossary.section().find(w) != null, w);
		}
		for (Glossary.Term t : ArchitectGlossary.TERMS) {
			assertTrue(WordingLint.breaks(t.meaning()).isEmpty(), t.word());
			assertTrue(t.meaning().length() <= Glossary.MAX_MEANING, t.word());
		}
		assertEquals(17, ArchitectGlossary.TERMS.size());
	}
}

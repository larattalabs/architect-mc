package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-1; row T4RDF-first-ledger) A world that never had a stockpile has no {@code stockpiles.json}. Its first owner
 * record, extraction attempt or removal result is durable state: the ordinary save and the confirmed write make the file, and a reload
 * finds it. Red before the fix: the empty-ledger shortcut answered OK with no file, and the reload found nothing.
 */
class T4RDFixFirstLedgerTest {
	@AfterEach
	void reset() throws Exception {
		Stockpiles.loadFrom(Files.createTempDirectory("t4rdf-reset-"));
	}

	static JsonObject ownerRecord() {
		return JsonParser.parseString("{\"v\":1,\"kind\":\"site\",\"base\":\"a\",\"undoGroup\":\"u:a\",\"dim\":\"minecraft:overworld\",\"order\":[\"a\"],"
			+ "\"members\":{\"a\":{\"paid\":false,\"box\":[0,64,0,2,66,2],\"player\":[{\"pos\":1,\"block\":\"minecraft:sponge\",\"items\":{\"minecraft:sponge\":1},"
			+ "\"recipient\":\"p\"}]}},\"r1\":[]}").getAsJsonObject();
	}

	@Test
	void theFirstOwnerRecordMakesTheFile() throws Exception {
		System.out.println("ROW T4RDF-first-ledger (unit): owner record");
		Path d = Files.createTempDirectory("t4rdf-first-owner-");
		Stockpiles.loadFrom(d);
		OwnerRemovals.put("removal:a@u:a", ownerRecord());
		assertTrue(Stockpiles.save(), "the ordinary save answers saved");
		assertTrue(Files.exists(d.resolve(Stockpiles.FILE)), "T4RDF-first-ledger: the ordinary save wrote " + Stockpiles.FILE);
		Stockpiles.loadFrom(d);
		assertEquals(1, OwnerRemovals.records().size(), "T4RDF-first-ledger: a reload finds the owner record");
	}

	@Test
	void theConfirmedWriteOfTheFirstOwnerRecordMakesTheFile() throws Exception {
		System.out.println("ROW T4RDF-first-ledger (unit): confirmed write");
		Path d = Files.createTempDirectory("t4rdf-first-confirmed-");
		Stockpiles.loadFrom(d);
		OwnerRemovals.put("removal:a@u:a", ownerRecord());
		DurableFile.Result r = Stockpiles.writeConfirmed(null);
		assertTrue(r.ok(), "the confirmed write is OK");
		assertTrue(r.gen() > 0, "T4RDF-first-ledger: a generation was written (gen 0 is the no-file answer), got " + r);
		assertTrue(Files.exists(d.resolve(Stockpiles.FILE)), "T4RDF-first-ledger: the confirmed write made " + Stockpiles.FILE);
		Stockpiles.loadFrom(d);
		assertEquals(1, OwnerRemovals.records().size(), "T4RDF-first-ledger: a reload finds the owner record");
	}

	@Test
	void theFirstExtractionAttemptMakesTheFile() throws Exception {
		System.out.println("ROW T4RDF-first-ledger (unit): extraction attempt");
		Path d = Files.createTempDirectory("t4rdf-first-ext-");
		Stockpiles.loadFrom(d);
		Extractions.read(JsonParser.parseString("{\"r1@5\":{\"gen\":1,\"attempts\":{\"1\":{\"key\":\"pblocks:r1@5#1\",\"dim\":\"minecraft:overworld\","
			+ "\"target\":\"r1\",\"cells\":[{\"pos\":1,\"block\":\"minecraft:sponge\"}],\"state\":\"planned\"}}}}"));
		assertTrue(Stockpiles.writeConfirmed(null).gen() > 0, "T4RDF-first-ledger: the attempt's P0 save wrote a generation");
		Stockpiles.loadFrom(d);
		assertTrue(Extractions.json() != null, "T4RDF-first-ledger: a reload finds the attempt");
	}

	@Test
	void theFirstResultMakesTheFile() throws Exception {
		System.out.println("ROW T4RDF-first-ledger (unit): removal result");
		Path d = Files.createTempDirectory("t4rdf-first-res-");
		Stockpiles.loadFrom(d);
		JsonObject r = new JsonObject();
		r.add("refund", new JsonObject());
		r.add("owedParts", new JsonArray());
		OwnerRemovals.putResult("site:a", r);
		assertTrue(Stockpiles.writeConfirmed(null).gen() > 0, "T4RDF-first-ledger: the snapshot's save wrote a generation");
		Stockpiles.loadFrom(d);
		assertTrue(OwnerRemovals.result("site", "a") != null, "T4RDF-first-ledger: a reload finds the result");
	}
}

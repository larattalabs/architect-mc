package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.region.Ir;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (6c close-out A, §8; docs/CONTRACT.md "Phase 6c close-out A"): a region tile's plan parts (the IR parts whose ops' bounds meet the
 * tile's columns, in its stage and set, under their survival target group), the road and tile tags, and the stage wait's sentence.
 */
class RegionWaitTagsTest {
	private static final String IR = """
		{"format":2,"id":"t","kitVersion":"0","seed":"1","claim":{"minX":0,"minY":-64,"minZ":0,"maxX":255,"maxY":319,"maxZ":255},
		 "stages":["ground","walls"],"tiles":{},
		 "parts":[
		  {"id":"wall_n","stage":"walls","set":"terrain","ops":[{"op":"fill","bounds":{"minX":10,"maxX":120,"minZ":10,"maxZ":12}}]},
		  {"id":"wall_n_gate","stage":"walls","set":"terrain","ops":[{"op":"fill","bounds":{"minX":60,"maxX":66,"minZ":10,"maxZ":12}}]},
		  {"id":"pads","stage":"ground","set":"terrain","ops":[{"op":"fill","bounds":{"minX":0,"maxX":40,"minZ":0,"maxZ":40}}]},
		  {"id":"far","stage":"walls","set":"terrain","ops":[{"op":"fill","bounds":{"minX":200,"maxX":210,"minZ":200,"maxZ":210}}]},
		  {"id":"lane","stage":"walls","set":"path","ops":[{"op":"fill","bounds":{"minX":0,"maxX":5,"minZ":0,"maxZ":5}}]}],
		 "survival":{"format":1,"groups":["town_wall","zone_town"],"parts":{"wall_n":0,"wall_n_gate":0,"pads":1,"far":0,"lane":1},"pads":["pads"]}}
		""";

	@Test
	void aTilesPartsAreItsPlanParts() {
		Ir ir = Ir.of(JsonParser.parseString(IR).getAsJsonObject());
		// tile 0,0 is columns 0..63: in walls/terrain wall_n and its gate (one target group), far is in tile 3,3
		assertEquals(List.of("town_wall"), RegionWaitTags.tileParts(ir, "walls", "terrain", "0,0"));
		assertEquals(List.of("town_wall"), RegionWaitTags.tileParts(ir, "walls", "terrain", "3,3"));
		assertEquals(List.of("zone_town"), RegionWaitTags.tileParts(ir, "ground", "terrain", "0,0"));
		assertEquals(List.of("zone_town"), RegionWaitTags.tileParts(ir, "walls", "path", "0,0"));
		assertEquals(List.of(), RegionWaitTags.tileParts(ir, "walls", "terrain", "1,1"));
		JsonObject ext = new JsonObject();
		RegionWaitTags.tagTile(ext, "rg7", ir, "walls", "terrain", "0,0");
		assertEquals("rg7", ext.get("architect_mc:region").getAsString());
		assertEquals("[\"town_wall\"]", ext.get("architect_mc:parts").toString());
		assertEquals("town_wall", ext.get("architect_mc:part").getAsString());
		// a creative IR (no survival member): the IR's own part ids, two of them, so no single part
		JsonObject cj = JsonParser.parseString(IR).getAsJsonObject();
		cj.remove("survival");
		JsonObject ce = new JsonObject();
		RegionWaitTags.tagTile(ce, "rg8", Ir.of(cj), "walls", "terrain", "0,0");
		assertEquals("[\"wall_n\",\"wall_n_gate\"]", ce.get("architect_mc:parts").toString());
		assertFalse(ce.has("architect_mc:part"));
	}

	@Test
	void roadsAndTheSentence() {
		JsonObject ext = new JsonObject();
		RegionWaitTags.tagRoad(ext, "rg7", "street_e");
		assertEquals("rg7", ext.get("architect_mc:region").getAsString());
		assertEquals("street_e", ext.get("architect_mc:part").getAsString());
		// without a plan's labels: the ids with spaces
		assertEquals("Street e waits for town wall to be built", RegionWaitTags.say(null, "street_e", "town_wall"));
		// a lot and a road read their id (their plan label when the region has one)
		assertEquals("Cottage 1 waits for street e to be built", RegionWaitTags.say(null, "lot cottage_1", "road street_e"));
	}
}

package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (M5 IG) A grown lot's irrigation sources are its revision's bodies: {@link RegionFluids#drainLot} finds the lot's revision in the
 * effective IR (Revisions.merge stamps each added lot with its rid) and drains through that revision's own record, not the region's. A
 * lot of the realised plan stays rid 0 (the region's record, as IRR built it).
 */
class IgLotDrainTest {
	private static JsonObject o(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void aGrownLotIsItsRevisionsAndItsBodiesAreFoundInTheEffectiveIr() {
		JsonObject base = o("{\"parts\":[],\"roads\":[],\"lots\":[{\"id\":\"f1\",\"irrigation\":{\"bodies\":[\"f1_irr_0_0\"]}}],\"graph\":{\"nodes\":[],\"edges\":[]}}");
		JsonObject rv1 = o("{\"parts\":[],\"roads\":[],\"lots\":[{\"id\":\"farm_m\",\"irrigation\":{\"bodies\":[\"rv1_farm_m_irr_0_0\",\"rv1_farm_m_irr_1_0\"]}}],"
			+ "\"graph\":{\"nodes\":[],\"edges\":[]},\"revision\":{\"rid\":1}}");
		JsonObject rv2 = o("{\"parts\":[],\"roads\":[],\"lots\":[{\"id\":\"house_9\"}],\"graph\":{\"nodes\":[],\"edges\":[]},\"revision\":{\"rid\":2}}");
		JsonObject eff = Revisions.merge(Revisions.merge(base, rv1, 1, 1, "a"), rv2, 2, 2, "b");
		assertEquals(0, RegionFluids.lotRid(eff, "f1"), "the realised plan's lot");
		assertEquals(1, RegionFluids.lotRid(eff, "farm_m"), "the grown lot is revision 1's");
		assertEquals(2, RegionFluids.lotRid(eff, "house_9"));
		assertEquals(0, RegionFluids.lotRid(eff, "nope"));
		assertEquals(Set.of("rv1_farm_m_irr_0_0", "rv1_farm_m_irr_1_0"), RegionFluids.lotBodies(eff, "farm_m"));
		assertEquals(Set.of(), RegionFluids.lotBodies(eff, "house_9"));
		assertEquals(List.of("f1_irr_0_0"), List.copyOf(RegionFluids.lotBodies(eff, "f1")));
	}
}

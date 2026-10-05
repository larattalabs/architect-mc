package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The snapshot's protocol and features: absent = protocol 1 (a phase 1-3 sidecar). */
class ProtocolNegotiationTest {
	@Test
	void absentMeansProtocol1() {
		var snap = JsonParser.parseString("{\"type\":\"snapshot\",\"version\":\"0.1.0\",\"designs\":[]}").getAsJsonObject();
		assertEquals(1, SidecarState.protocolOf(snap));
		assertTrue(SidecarState.featuresOf(snap).isEmpty());
	}

	@Test
	void protocol2WithFeatures() {
		var snap = JsonParser.parseString("{\"type\":\"snapshot\",\"protocol\":2,\"features\":[\"job.run\",\"budget\"]}").getAsJsonObject();
		assertEquals(2, SidecarState.protocolOf(snap));
		assertEquals(Set.of("job.run", "budget"), SidecarState.featuresOf(snap));
	}
}

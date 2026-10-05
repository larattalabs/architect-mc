package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Library;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.junit.jupiter.api.Test;

/** The blueprint JSON's {@code ports} as {@link Library.Port}s (R5): list and object forms; invalid ones skipped. */
class PortsJsonTest {
	private static Map<String, Library.Port> ports(String json) {
		return Views.ports(JsonParser.parseString(json).getAsJsonObject());
	}

	@Test
	void listForm() {
		Map<String, Library.Port> p = ports("{\"ports\":[{\"name\":\"chest\",\"kind\":\"item_out\",\"x\":1,\"y\":2,\"z\":3,\"facing\":\"north\"},"
			+ "{\"name\":\"mill\",\"kind\":\"steward_mc:grain_in\",\"x\":4,\"y\":1,\"z\":0,\"facing\":\"east\"}]}");
		assertEquals(2, p.size());
		assertEquals(new Library.Port("chest", "item_out", new BlockPos(1, 2, 3), Direction.NORTH), p.get("chest"));
		assertEquals(Direction.EAST, p.get("mill").facing());
		assertEquals("steward_mc:grain_in", p.get("mill").kind());
	}

	@Test
	void objectFormAndInvalidOnesSkipped() {
		Map<String, Library.Port> p = ports("{\"ports\":{\"door\":{\"kind\":\"door\",\"x\":5,\"y\":1,\"z\":12,\"facing\":\"south\"},"
			+ "\"up\":{\"kind\":\"item_in\",\"x\":0,\"y\":0,\"z\":0,\"facing\":\"up\"},"
			+ "\"broken\":{\"kind\":\"item_in\",\"x\":\"a\",\"facing\":\"west\"}}}");
		assertEquals(1, p.size());
		assertEquals(new Library.Port("door", "door", new BlockPos(5, 1, 12), Direction.SOUTH), p.get("door"));
	}

	@Test
	void none() {
		assertTrue(Views.ports(new JsonObject()).isEmpty());
		assertTrue(ports("{\"ports\":42}").isEmpty());
	}
}

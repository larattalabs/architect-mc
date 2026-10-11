package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import com.google.gson.JsonObject;
import java.util.List;
import org.junit.jupiter.api.Test;

/** (6c 0a, C9) A batch's body hash: canonical JSON, the key left out, records recursed. */
class BatchKeysTest {
	record Inner(String b, int a) {
	}

	record Spec(String name, List<Inner> items, JsonObject ext, String opKey) {
	}

	@Test
	void canonicalSortsKeysAndLeavesTheKeyOut() {
		JsonObject e1 = new JsonObject();
		e1.addProperty("z", 1);
		e1.addProperty("a", 2);
		JsonObject e2 = new JsonObject();
		e2.addProperty("a", 2);
		e2.addProperty("z", 1);
		String h1 = BatchKeys.hash(new Spec("s", List.of(new Inner("x", 1)), e1, "k1"));
		String h2 = BatchKeys.hash(new Spec("s", List.of(new Inner("x", 1)), e2, "k2"));
		assertEquals(h1, h2);
		assertNotEquals(h1, BatchKeys.hash(new Spec("s", List.of(new Inner("x", 2)), e1, "k1")));
		assertEquals("{\"a\":1,\"b\":\"x\"}", BatchKeys.canonical(BatchKeys.json(new Inner("x", 1), false)));
	}
}

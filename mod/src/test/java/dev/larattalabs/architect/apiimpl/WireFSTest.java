package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Designs;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Library.Derivation;
import dev.larattalabs.architect.api.Library.Follower;
import java.lang.reflect.Proxy;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.Set;
import net.minecraft.core.Direction;
import org.junit.jupiter.api.Test;

/** Slice 6d FS (API NEXT): followers from the loaded entries, the follow results' wire, the feature name, the defaults that throw. */
class WireFSTest {
	static Library.Entry entry(String id, int version, Derivation d) {
		return new Library.Entry(id, id, "cabin", new BlockSize(11, 12, 12), List.of(), Optional.of(id + ".mjs"), Map.of(), Map.of(), Optional.empty(),
			Map.of(), new JsonObject(), false, false, Optional.ofNullable(d == null ? null : d.source()), Optional.empty(), Optional.empty(),
			Optional.empty(), Map.of(), Direction.SOUTH, Map.of(), 1, Library.Approach.DEFAULT, Optional.empty(), version, List.of(),
			Optional.ofNullable(d), OptionalInt.empty());
	}

	static Library lib(List<Library.Entry> entries) {
		return (Library) Proxy.newProxyInstance(Library.class.getClassLoader(), new Class<?>[] {Library.class}, (p, m, a) -> switch (m.getName()) {
			case "list" -> entries.stream().sorted(Comparator.comparing(Library.Entry::id)).toList();
			case "get" -> entries.stream().filter(e -> e.id().equals(a[0])).findFirst();
			default -> throw new UnsupportedOperationException(m.getName());
		});
	}

	static Derivation der(String src, int v, Derivation.Kind k) {
		return new Derivation(src, v, k, new JsonObject());
	}

	@Test
	void followersListTheFamilyAndOnlyCopiesAreBehind() {
		Library l = lib(List.of(entry("arch", 2, null), entry("c1", 1, der("arch", 1, Derivation.Kind.COPY)), entry("c2", 2, der("arch", 2,
			Derivation.Kind.COPY)), entry("c3", 1, der("arch", 1, Derivation.Kind.COPY)), entry("v1", 1, der("arch", 1, Derivation.Kind.VARIANT)),
			entry("r1", 1, der("arch", 1, Derivation.Kind.RESKIN)), entry("s1", 1, der("arch", 1, Derivation.Kind.SITE)), entry("other", 1, der("x", 1,
				Derivation.Kind.COPY))));
		List<Follower> f = WireFS.followers(l, "arch");
		assertEquals(List.of("c1", "c2", "c3", "r1", "s1", "v1"), f.stream().map(Follower::entryId).toList());
		assertEquals(List.of("c1", "c3"), f.stream().filter(Follower::behind).map(Follower::entryId).toList());
		Follower c1 = f.get(0);
		assertEquals(new Follower("c1", Derivation.Kind.COPY, 1, 1, 2, true), c1);
		assertEquals(List.of(), WireFS.followers(l, "nothing"));
		// a gone source: listed with sourceHead 0, never behind
		List<Follower> gone = WireFS.followers(l, "x");
		assertEquals(1, gone.size());
		assertEquals(0, gone.get(0).sourceHead());
		assertFalse(gone.get(0).behind());
	}

	@Test
	void resultsWire() {
		JsonObject op = JsonParser.parseString("{\"id\":\"key-a\",\"status\":\"done\",\"results\":[{\"entryId\":\"c1\",\"followed\":true,\"fromVersion\":1,"
			+ "\"newVersion\":2,\"sourceVersion\":2,\"refused\":null,\"alreadyFollowed\":false,\"message\":\"ok\"},{\"entryId\":\"c2\",\"followed\":false,"
			+ "\"fromVersion\":1,\"newVersion\":1,\"sourceVersion\":2,\"refused\":\"frame\",\"alreadyFollowed\":false,\"message\":\"the frame changed\"}]}")
			.getAsJsonObject();
		List<Designs.FollowResult> rs = WireFS.results(op);
		assertEquals(new Designs.FollowResult("c1", true, 1, 2, 2, null, false, "ok"), rs.get(0));
		assertEquals("frame", rs.get(1).refused());
		assertNull(rs.get(0).refused());
		assertEquals(List.of(), WireFS.results(new JsonObject()));
	}

	@Test
	void featureNameAndDefaults() {
		assertTrue(ApiRules.features(2, Set.of("entry.follow")).contains("followSource"));
		assertFalse(ApiRules.features(1, Set.of("entry.follow")).contains("followSource"));
		Library bare = (Library) Proxy.newProxyInstance(Library.class.getClassLoader(), new Class<?>[] {Library.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new UnsupportedOperationException(m.getName());
		});
		UnsupportedOperationException e = org.junit.jupiter.api.Assertions.assertThrows(UnsupportedOperationException.class, () -> bare.followers("a"));
		assertTrue(e.getMessage().contains("Library.followers"));
	}
}

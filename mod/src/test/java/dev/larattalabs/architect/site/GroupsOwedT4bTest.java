package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (slice T4b, finding 5 of the T2b last-round review) A group removal's owed keys survive its queue file: member A settles and its stash
 * goes, the queue is saved, the world restarts before member B: the final result still names A's keys. On the T4a base
 * {@code Removal.toJson} never wrote them (red: the loaded removal's owed list was empty).
 */
class GroupsOwedT4bTest {
	@Test
	void aGroupRemovalsOwedKeysSurviveItsQueueFile() {
		Groups.Removal r = new Groups.Removal("g7", null, null, false);
		r.owed.add("crate:g7@1,2,3/group:g7");
		r.owed.add("refund:crate:s4@1,2,3/site:s4@99");
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals(List.of("crate:g7@1,2,3/group:g7", "refund:crate:s4@1,2,3/site:s4@99"), back.owed);
	}
}

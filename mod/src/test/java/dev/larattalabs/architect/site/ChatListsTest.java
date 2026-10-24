package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import org.junit.jupiter.api.Test;

/** UI-2b: the paged chat lists' {@code [page] [filter]} argument and the footer's commands. */
class ChatListsTest {
	@Test
	void pageThenFilter() {
		assertEquals(new ChatLists.Args(1, null), ChatLists.Args.parse(null));
		assertEquals(new ChatLists.Args(1, null), ChatLists.Args.parse("  "));
		assertEquals(new ChatLists.Args(3, null), ChatLists.Args.parse("3"));
		assertEquals(new ChatLists.Args(2, "cabin"), ChatLists.Args.parse("2 cabin"));
		assertEquals(new ChatLists.Args(1, "cabin oak"), ChatLists.Args.parse("cabin oak"), "no number: all of it is the filter");
		assertEquals(new ChatLists.Args(1, "3x3 hut"), ChatLists.Args.parse("3x3 hut"), "a word starting with a digit is a filter");
		assertEquals(new ChatLists.Args(1, null), ChatLists.Args.parse("0"), "pages are 1-based");
		assertNull(ChatLists.Args.parse("7").filter());
	}

	@Test
	void theCommandOfAPageKeepsTheFilter() {
		assertEquals("/architect list 2 cabin", ChatLists.Args.parse("1 cabin").command("/architect list", 2));
		assertEquals("/architect batches 4", ChatLists.Args.NONE.command("/architect batches", 4));
	}

	@Test
	void eightAPageWithClickablePrevAndNext() {
		List<Component> lines = new ArrayList<>();
		for (int i = 1; i <= 20; i++) {
			lines.add(Component.literal("design d" + i));
		}
		List<Component> p2 = ChatLists.pager(lines, ChatLists.Args.parse("2"), "/architect list").build();
		assertEquals(9, p2.size(), "8 lines and the footer");
		assertEquals("design d9", p2.get(0).getString());
		Component footer = p2.get(8);
		assertTrue(footer.getString().contains("page 2/3"), footer.getString());
		List<String> runs = new ArrayList<>();
		footer.visit((Style st, String t) -> {
			if (st.getClickEvent() instanceof ClickEvent.RunCommand r) {
				runs.add(t + "=" + r.command());
			}
			return java.util.Optional.empty();
		}, Style.EMPTY);
		assertEquals(List.of("[‹ prev]=/architect list 1", "[next ›]=/architect list 3"), runs);
		List<Component> filtered = ChatLists.pager(lines, ChatLists.Args.parse("d1"), "/architect list").build();
		assertEquals(9, filtered.size(), "d1 and d10..d19: 11 lines, one page of 8 and the footer");
	}
}

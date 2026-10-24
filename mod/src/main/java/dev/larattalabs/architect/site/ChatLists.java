package dev.larattalabs.architect.site;

import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.labui.ui.ChatPager;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * The paged chat lists of {@code /architect} (UI-2b): lab-ui's {@link ChatPager}, {@value #PAGE_SIZE} lines a page, a footer
 * with clickable [‹ prev] / [next ›] and [filter…]. Every list command takes {@code [page] [filter]} as one trailing greedy
 * argument ({@link Args#parse}), so {@code /architect list cabin} filters and {@code /architect list 2 cabin} pages the filter.
 */
public final class ChatLists {
	public static final int PAGE_SIZE = 8;
	/** The name of the trailing greedy argument every list command takes. */
	public static final String ARG = "args";

	private ChatLists() {
	}

	/** {@code [page] [filter]}: a leading whole number is the page (1-based), the rest the filter (null = none). */
	public record Args(int page, @Nullable String filter) {
		public static final Args NONE = new Args(1, null);

		/** Pure (unit-tested in {@code ChatListsTest}). */
		public static Args parse(@Nullable String raw) {
			String s = raw == null ? "" : raw.strip();
			if (s.isEmpty()) {
				return NONE;
			}
			int sp = s.indexOf(' ');
			String first = sp < 0 ? s : s.substring(0, sp);
			if (first.matches("\\d{1,6}")) {
				String rest = sp < 0 ? "" : s.substring(sp + 1).strip();
				return new Args(Math.max(1, Integer.parseInt(first)), rest.isEmpty() ? null : rest);
			}
			return new Args(1, s);
		}

		/** The command that shows page {@code n} with this filter: {@code base + " " + n [+ " " + filter]}. */
		public String command(String base, int n) {
			return base + " " + n + (filter == null ? "" : " " + filter);
		}
	}

	/** The trailing {@value #ARG} argument, or none when the command was run without it. */
	public static Args args(CommandContext<CommandSourceStack> ctx) {
		try {
			return Args.parse(com.mojang.brigadier.arguments.StringArgumentType.getString(ctx, ARG));
		} catch (IllegalArgumentException none) {
			return Args.NONE;
		}
	}

	/** Sends one page of {@code lines} (plus the footer when there is more than a page); {@code base} is the list's command. */
	public static void send(CommandSourceStack src, List<Component> lines, Args a, String base) {
		for (Component c : pager(lines, a, base).build()) {
			src.sendSuccess(() -> c, false);
		}
	}

	public static ChatPager pager(List<Component> lines, Args a, String base) {
		return ChatPager.of(lines).pageSize(PAGE_SIZE).page(a.page()).filter(a.filter()).pageCommand(n -> a.command(base, n))
			.filterCommand(base + " 1 ");
	}
}

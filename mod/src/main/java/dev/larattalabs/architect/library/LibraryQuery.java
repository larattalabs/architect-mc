package dev.larattalabs.architect.library;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;
import org.jspecify.annotations.Nullable;

/**
 * The Library tab's filters and sort (docs/CONTRACT.md "Mod: library screen"): type, user tag, favourites only, text search
 * over name/tags/description; newest, name, size. Pure.
 *
 * @param type a building type, or null for all
 * @param tag a user tag, or null for all
 * @param favoritesOnly only starred entries
 * @param text words that must all appear (case-insensitive) in the name, the design's name, id, tags, user tags or description
 * @param collection a collection (phase 4b, R10): {@code bible:<id>} (every entry designed or re-skinned with that bible) or
 *     {@code group:<id>} (a design group's entries), or null for all
 */
public record LibraryQuery(@Nullable String type, @Nullable String tag, boolean favoritesOnly, String text, Sort sort, @Nullable String collection) {
	public static final LibraryQuery ALL = new LibraryQuery(null, null, false, "", Sort.NEWEST, null);
	public static final String BIBLE_PREFIX = "bible:";
	public static final String GROUP_PREFIX = "group:";

	/** The phase 2 constructor (no collection). */
	public LibraryQuery(@Nullable String type, @Nullable String tag, boolean favoritesOnly, String text, Sort sort) {
		this(type, tag, favoritesOnly, text, sort, null);
	}

	public enum Sort {
		NEWEST, NAME, SIZE;

		public String id() {
			return name().toLowerCase(Locale.ROOT);
		}

		public String label() {
			return switch (this) {
				case NEWEST -> "Newest";
				case NAME -> "Name";
				case SIZE -> "Size";
			};
		}

		public static @Nullable Sort of(@Nullable String s) {
			for (Sort x : values()) {
				if (x.id().equalsIgnoreCase(s)) {
					return x;
				}
			}
			return null;
		}
	}

	public LibraryQuery {
		type = type == null || type.isBlank() ? null : type;
		tag = tag == null || tag.isBlank() ? null : tag;
		text = text == null ? "" : text;
		sort = sort == null ? Sort.NEWEST : sort;
		collection = collection == null || collection.isBlank() ? null : collection;
	}

	public LibraryQuery withType(@Nullable String t) {
		return new LibraryQuery(t, tag, favoritesOnly, text, sort, collection);
	}

	public LibraryQuery withTag(@Nullable String t) {
		return new LibraryQuery(type, t, favoritesOnly, text, sort, collection);
	}

	public LibraryQuery withFavoritesOnly(boolean on) {
		return new LibraryQuery(type, tag, on, text, sort, collection);
	}

	public LibraryQuery withText(String t) {
		return new LibraryQuery(type, tag, favoritesOnly, t, sort, collection);
	}

	public LibraryQuery withSort(Sort s) {
		return new LibraryQuery(type, tag, favoritesOnly, text, s, collection);
	}

	public LibraryQuery withCollection(@Nullable String c) {
		return new LibraryQuery(type, tag, favoritesOnly, text, sort, c);
	}

	public boolean filtered() {
		return type != null || tag != null || favoritesOnly || !text.isBlank() || collection != null;
	}

	public boolean matches(LibraryCard c) {
		if (type != null && !type.equals(c.type())) {
			return false;
		}
		if (tag != null && !c.userTags().contains(tag)) {
			return false;
		}
		if (favoritesOnly && !c.favorite()) {
			return false;
		}
		if (collection != null && !c.collections().contains(collection)) {
			return false;
		}
		String q = text.strip().toLowerCase(Locale.ROOT);
		if (q.isEmpty()) {
			return true;
		}
		String hay = String.join("\n", c.name(), c.baseName(), c.id(), String.join(" ", c.tags()), String.join(" ", c.userTags()), c.description())
			.toLowerCase(Locale.ROOT);
		for (String word : q.split("\\s+")) {
			if (!hay.contains(word)) {
				return false;
			}
		}
		return true;
	}

	/** The cards that pass, in the chosen order (ties by id, so the order is stable). */
	public List<LibraryCard> apply(Collection<LibraryCard> cards) {
		List<LibraryCard> out = new ArrayList<>();
		for (LibraryCard c : cards) {
			if (matches(c)) {
				out.add(c);
			}
		}
		out.sort(comparator(sort));
		return out;
	}

	public static Comparator<LibraryCard> comparator(Sort sort) {
		Comparator<LibraryCard> byId = Comparator.comparing(LibraryCard::id);
		return switch (sort) {
			case NEWEST -> Comparator.comparingLong(LibraryCard::createdAt).reversed().thenComparing(byId);
			case NAME -> Comparator.comparing((LibraryCard c) -> c.name().toLowerCase(Locale.ROOT)).thenComparing(byId);
			case SIZE -> Comparator.comparingLong(LibraryCard::volume).thenComparingInt(LibraryCard::sizeY).thenComparing(byId);
		};
	}

	/** The types present, sorted. */
	public static List<String> types(Collection<LibraryCard> cards) {
		TreeSet<String> s = new TreeSet<>();
		cards.forEach(c -> s.add(c.type()));
		return List.copyOf(s);
	}

	/** A collection present among the cards: its key ({@code bible:<id>} / {@code group:<id>}) and how many entries it has. */
	public record CollectionInfo(String key, String id, boolean bible, int count) {
	}

	/** The collections present: bibles first, then groups, each by id. */
	public static List<CollectionInfo> collections(java.util.Collection<LibraryCard> cards) {
		java.util.TreeMap<String, Integer> bibles = new java.util.TreeMap<>();
		java.util.TreeMap<String, Integer> groups = new java.util.TreeMap<>();
		for (LibraryCard c : cards) {
			if (c.bible() != null) {
				bibles.merge(c.bible(), 1, Integer::sum);
			}
			if (c.group() != null) {
				groups.merge(c.group(), 1, Integer::sum);
			}
		}
		List<CollectionInfo> out = new ArrayList<>();
		bibles.forEach((id, n) -> out.add(new CollectionInfo(BIBLE_PREFIX + id, id, true, n)));
		groups.forEach((id, n) -> out.add(new CollectionInfo(GROUP_PREFIX + id, id, false, n)));
		return out;
	}

	/** The user tags present, sorted. */
	public static List<String> userTags(Collection<LibraryCard> cards) {
		TreeSet<String> s = new TreeSet<>();
		cards.forEach(c -> s.addAll(c.userTags()));
		return List.copyOf(s);
	}
}

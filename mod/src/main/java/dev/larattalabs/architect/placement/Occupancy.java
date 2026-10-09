package dev.larattalabs.architect.placement;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.OwnableEntity;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.entity.projectile.arrow.ThrownTrident;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;

/**
 * Who is in the way of a placement (docs/BUILDINGS.md "Occupancy"): {@link Buildings#place} and the wizard's
 * ghost use the same rules, so the ghost says what the server will say.
 * <ul>
 * <li>a player whose box grown by one block touches the placement box: refused (they would be built into the
 * walls or sealed in);</li>
 * <li>tamed / owned animals (dogs, cats, horses, parrots...) and leashed ones: refused, named;</li>
 * <li>hostile mobs that would despawn anyway (no name, no picked-up loot, not persistent): removed with a note,
 * so a zombie wandering through does not block a build at night; named or persistent ones refuse (a mob that
 * picked up the player's gear carries it);</li>
 * <li>any other living entity (villagers, animals, armor stands) and anything else (item frames, minecarts, boats)
 * refuses, named;</li>
 * <li>natural drops ({@link NaturalDrops}: sticks, saplings, leaf litter... that nobody threw) are cleared with a note;</li>
 * <li>other dropped items inside the box refuse ("pick them up first": they would be sealed into the walls), and so do a
 * thrown trident and an arrow the player can pick up (an enchanted trident lost to a placement in Hardcore);
 * arrows nobody can pick up (a skeleton's, a creative or Infinity shot) and XP are removed.</li>
 * </ul>
 * Removal is the safer UX for hostiles: the player cannot shoo a creeper out of a box, and refusing until morning
 * is worse; everything that may matter to the player refuses instead.
 */
public final class Occupancy {
	/** What an entity in the box is. */
	public enum Kind {
		PLAYER, OWNED, HOSTILE, LIVING, ITEM, PROJECTILE, OTHER,
		/** A natural drop ({@link NaturalDrops}: sticks, saplings, leaf litter, seeds... nobody threw): cleared with a note. */
		DROP
	}

	/**
	 * One entity in the way.
	 *
	 * @param name what to call it ("you", "zombie", "Rex (wolf)")
	 * @param keep whether it matters to the player (a name, picked-up loot, persistence): never removed
	 */
	public record Found(Kind kind, String name, boolean keep) {
		/** Whether placing removes it instead of refusing. */
		public boolean removable() {
			return kind == Kind.PROJECTILE || kind == Kind.DROP || kind == Kind.HOSTILE && !keep;
		}
	}

	/**
	 * Phase 6a: set (server thread) while a region's item is checked or starts. Regions are creative-only (N4), and their own
	 * terrain writes kill the animals in their way: items nobody threw count as natural drops there, so a region never waits on
	 * a cow's beef.
	 */
	public static boolean regionScope;

	/** The refusal for "a player in the box" (the ghost uses the same words). */
	public static final String PLAYER_IN_BOX = "you are standing in or next to the box (look further away or nudge it)";

	private Occupancy() {
	}

	// ------------------------------------------------------------------ pure rules

	/** The refusals for what was found, grouped by name ("3 zombies"), in a stable order (players first). Empty = only removable ones. */
	public static List<String> refusals(List<Found> found) {
		List<String> out = new ArrayList<>();
		if (found.stream().anyMatch(f -> f.kind() == Kind.PLAYER)) {
			out.add(PLAYER_IN_BOX);
		}
		Map<String, Integer> owned = count(found, f -> f.kind() == Kind.OWNED);
		if (!owned.isEmpty()) {
			out.add("pets in the box: " + join(owned) + " (lead them out)");
		}
		Map<String, Integer> others = count(found, f -> !f.removable() && f.kind() != Kind.PLAYER && f.kind() != Kind.OWNED && f.kind() != Kind.ITEM);
		if (!others.isEmpty()) {
			out.add("in the box: " + join(others) + " (move them out)");
		}
		Map<String, Integer> items = count(found, f -> f.kind() == Kind.ITEM);
		if (!items.isEmpty()) {
			out.add("dropped items in the box: " + join(items) + " (pick them up first)");
		}
		return out;
	}

	/** The note for what placing removes ("removes 2 zombies, 1 skeleton in the box"), or null when nothing. */
	public static String removalNote(List<Found> found) {
		Map<String, Integer> hostile = count(found, f -> f.kind() == Kind.HOSTILE && f.removable());
		long drops = found.stream().filter(f -> f.kind() == Kind.DROP).count();
		List<String> parts = new ArrayList<>();
		if (!hostile.isEmpty()) {
			parts.add("removes " + join(hostile) + " in the box");
		}
		if (drops > 0) {
			parts.add("clears " + drops + " natural drop" + (drops == 1 ? "" : "s") + " (sticks, saplings, leaf litter...)");
		}
		return parts.isEmpty() ? null : String.join("; ", parts);
	}

	private static Map<String, Integer> count(List<Found> found, Predicate<Found> which) {
		Map<String, Integer> out = new LinkedHashMap<>();
		for (Found f : found) {
			if (which.test(f)) {
				out.merge(f.name(), 1, Integer::sum);
			}
		}
		return out;
	}

	private static String join(Map<String, Integer> counts) {
		List<String> parts = new ArrayList<>();
		int shown = 0;
		for (var e : counts.entrySet()) {
			if (shown++ == 5) {
				parts.add("...");
				break;
			}
			parts.add(e.getValue() == 1 ? e.getKey() : e.getValue() + " × " + e.getKey());
		}
		return String.join(", ", parts);
	}

	// ------------------------------------------------------------------ entities

	/** The box as an entity AABB (cells fill x..x+1). */
	public static AABB aabb(Anchors.Bounds box) {
		return new AABB(box.minX(), box.minY(), box.minZ(), box.maxX() + 1, box.maxY() + 1, box.maxZ() + 1);
	}

	/**
	 * Everything in the way of a placement over {@code box} in {@code level}, client or server. {@code ignore}
	 * skips entities that are not really there (client-only entities).
	 */
	public static List<Found> scan(Level level, Anchors.Bounds box, Predicate<Entity> ignore) {
		AABB area = aabb(box);
		List<Found> out = new ArrayList<>();
		for (Player p : level.players()) {
			if (!p.isSpectator() && !ignore.test(p) && p.getBoundingBox().inflate(1).intersects(area)) {
				out.add(new Found(Kind.PLAYER, p.getPlainTextName(), true));
			}
		}
		for (Entity e : level.getEntities((Entity) null, area, e -> !(e instanceof Player) && e.isAlive() && !ignore.test(e))) {
			out.add(classify(e));
		}
		return out;
	}

	/**
	 * Whether a stuck arrow or trident is the player's to pick up. A trident always counts. An arrow counts when its
	 * {@code pickup} is {@code ALLOWED}; that field is not synced, so on the client (the ghost) an arrow counts when a
	 * player shot it, if the client knows the shooter, so the ghost can miss an arrow the server then refuses (tridents
	 * count on both sides).
	 */
	static boolean pickable(AbstractArrow arrow) {
		if (arrow instanceof ThrownTrident) {
			return true;
		}
		if (arrow.level().isClientSide()) {
			return arrow.getOwner() instanceof Player;
		}
		return arrow.pickup == AbstractArrow.Pickup.ALLOWED;
	}

	/** One entity's kind and name. */
	public static Found classify(Entity e) {
		String type = e.getType().getDescription().getString().toLowerCase(Locale.ROOT);
		String name = e.hasCustomName() ? e.getCustomName().getString() + " (" + type + ")" : type;
		boolean owned = e instanceof TamableAnimal t && t.isTame() || e instanceof OwnableEntity o && o.getOwnerReference() != null
			|| e instanceof Mob m && m.isLeashed();
		if (owned) {
			return new Found(Kind.OWNED, name, true);
		}
		if (e instanceof ItemEntity item && NaturalDrops.natural(item)) {
			// leaves decaying around the site, plants the placement cleared: nobody's items, so they never block a placement
			return new Found(Kind.DROP, item.getItem().getHoverName().getString(), false);
		}
		if (e instanceof ItemEntity item && regionScope && !(item.getOwner() instanceof Player) && !item.getItem().has(net.minecraft.core.component.DataComponents.CUSTOM_NAME)) {
			// phase 6a: inside a region's item, loot nobody threw is a mob's (the region's own carve kills animals in its way): cleared
			return new Found(Kind.DROP, item.getItem().getHoverName().getString(), false);
		}
		if (e instanceof ItemEntity item) {
			String what = item.getItem().getHoverName().getString();
			return new Found(Kind.ITEM, item.getItem().getCount() > 1 ? what + " ×" + item.getItem().getCount() : what, true);
		}
		if (e instanceof ExperienceOrb) {
			return new Found(Kind.PROJECTILE, "experience", false); // harmless: XP is removed, it never matters
		}
		if (e instanceof AbstractArrow arrow && pickable(arrow)) {
			return new Found(Kind.ITEM, name, true); // the player's: "pick them up first", never discarded
		}
		if (e instanceof Projectile) {
			return new Found(Kind.PROJECTILE, type, false);
		}
		if (e instanceof Enemy && e instanceof Mob m) {
			return new Found(Kind.HOSTILE, name, e.hasCustomName() || m.isPersistenceRequired());
		}
		if (e instanceof LivingEntity) {
			return new Found(Kind.LIVING, name, true);
		}
		return new Found(Kind.OTHER, name, true);
	}
}

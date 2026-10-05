package dev.larattalabs.architect.api;

/**
 * A placement refusal's type.
 * <ul>
 * <li>{@code PLAYER_IN_BOX}: a player stands in or next to the box.</li>
 * <li>{@code OCCUPIED}: a pet, villager, named mob or other entity that matters is in the box.</li>
 * <li>{@code OVERLAP}: the box overlaps another site.</li>
 * <li>{@code LAVA}: lava in or next to the box or the approach.</li>
 * <li>{@code BLOCK_ENTITIES}: the box holds block entities (chests, ...); {@code force} overwrites them.</li>
 * <li>{@code BUILD_HEIGHT}: the box leaves the world's build height.</li>
 * <li>{@code DOOR_CUT}: a door is cut in half by the box edge.</li>
 * <li>{@code CREATIVE_ONLY_BLOCK}: a construction site of a design with blocks survival can't build.</li>
 * <li>{@code NOT_ALLOWED}: the mode needs a permission the actor lacks (INSTANT in a survival world), or a move in survival.</li>
 * <li>{@code NOT_LOADED}: part of the site is in an unloaded chunk (or the dimension is not loaded).</li>
 * <li>{@code UNKNOWN_BLUEPRINT}: no loaded design with that id.</li>
 * <li>{@code OTHER}: anything else (an I/O error, the world's sites file could not be read, an internal problem).</li>
 * <li>{@code CANCELLED} (1.4.0): a batch item dropped or rolled back by {@link Sites#cancelBatch} (or a skipped stage, a stopped batch).</li>
 * <li>{@code LOT_TOO_SMALL} (1.4.0): {@link Sites#fitToLot}: the footprint does not fit the lot after rotation and setback.</li>
 * <li>{@code TIMED_OUT} (1.4.0): a batch item waited longer than its {@code WaitPolicy} for a temporary blocker; the message
 * names the blocker.</li>
 * <li>{@code OVERLAP_BUSY} (1.5.0): a LAYER placement over a site that is still placing, a construction site still building, or
 * a site being removed. Temporary: a queued item waits.</li>
 * <li>{@code OVERLAP_OWNED} (1.5.0): a LAYER placement (or a road over a cell site) over a site of another owner; {@code force}
 * overrides it.</li>
 * <li>{@code LAYER_DEPTH} (1.5.0): a cell would carry more than 8 active layers.</li>
 * <li>{@code COVERED} (1.5.0): a removal with {@code CoveredPolicy.REFUSE} of a site another site covers.</li>
 * <li>{@code TOO_STEEP} (1.5.0): a road column would need more than 4 of cut or fill.</li>
 * <li>{@code DEEP_WATER} (1.5.0): a road over water deeper than 1 (bridges are phase 6).</li>
 * <li>{@code TOO_LARGE} (1.5.0): a cell site of more than 1,000,000 cells.</li>
 * <li>{@code JOURNAL_UNAVAILABLE} (1.5.0): the world journal could not be read; nothing changes the world until it is fixed.</li>
 * </ul>
 * New values are only ever appended.
 */
public enum Reason {
	PLAYER_IN_BOX, OCCUPIED, OVERLAP, LAVA, BLOCK_ENTITIES, BUILD_HEIGHT, DOOR_CUT, CREATIVE_ONLY_BLOCK, NOT_ALLOWED, NOT_LOADED,
	UNKNOWN_BLUEPRINT, OTHER, CANCELLED, LOT_TOO_SMALL, TIMED_OUT, OVERLAP_BUSY, OVERLAP_OWNED, LAYER_DEPTH, COVERED, TOO_STEEP, DEEP_WATER,
	TOO_LARGE, JOURNAL_UNAVAILABLE
}

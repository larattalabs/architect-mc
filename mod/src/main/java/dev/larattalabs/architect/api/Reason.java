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
 * <li>{@code NOT_ALLOWED}: the mode needs a permission the actor lacks, or the sites file could not be read.</li>
 * <li>{@code NOT_LOADED}: part of the site is in an unloaded chunk (or the dimension is not loaded).</li>
 * <li>{@code UNKNOWN_BLUEPRINT}: no loaded design with that id.</li>
 * <li>{@code OTHER}: anything else (an I/O error, an internal problem).</li>
 * </ul>
 */
public enum Reason {
	PLAYER_IN_BOX, OCCUPIED, OVERLAP, LAVA, BLOCK_ENTITIES, BUILD_HEIGHT, DOOR_CUT, CREATIVE_ONLY_BLOCK, NOT_ALLOWED, NOT_LOADED,
	UNKNOWN_BLUEPRINT, OTHER
}

package dev.larattalabs.architect.site;

import net.minecraft.server.level.ServerLevel;

/**
 * (slice LR2-FIX) Read by {@link EntityWait}: whether a chunk's entity sections are accessible ({@code getEntitiesOfClass} walks only those).
 * Implemented on vanilla's {@code PersistentEntitySectionManager} by {@code EntityVisibilityMixin}; {@code ServerLevelEntitiesAccessor}
 * reaches a level's manager.
 */
public interface EntityVisibilityView {
	/** Whether {@code chunk}'s entity visibility is accessible (TRACKED or TICKING). */
	boolean architect$accessible(long chunk);

	/** A level's sections of {@code chunk} are accessible. */
	static boolean accessible(ServerLevel level, long chunk) {
		Object m = ((dev.larattalabs.architect.mixin.ServerLevelEntitiesAccessor) level).architect$entityManager();
		return m instanceof EntityVisibilityView v && v.architect$accessible(chunk);
	}
}

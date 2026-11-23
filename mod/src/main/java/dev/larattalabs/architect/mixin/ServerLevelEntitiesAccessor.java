package dev.larattalabs.architect.mixin;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.entity.PersistentEntitySectionManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** (slice LR2-FIX) A level's entity manager, for {@code EntityVisibilityView.accessible}. */
@Mixin(ServerLevel.class)
public interface ServerLevelEntitiesAccessor {
	@Accessor("entityManager")
	PersistentEntitySectionManager<Entity> architect$entityManager();
}

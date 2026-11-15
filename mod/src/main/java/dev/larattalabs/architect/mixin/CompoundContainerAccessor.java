package dev.larattalabs.architect.mixin;

import net.minecraft.world.CompoundContainer;
import net.minecraft.world.Container;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** (FK-b) A double chest's halves, so the fill guard maps a slot of the compound container to its block ({@code FillGuard.resolve}). */
@Mixin(CompoundContainer.class)
public interface CompoundContainerAccessor {
	@Accessor("container1")
	Container architect$first();

	@Accessor("container2")
	Container architect$second();
}

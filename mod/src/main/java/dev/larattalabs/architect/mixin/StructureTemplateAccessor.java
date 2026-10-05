package dev.larattalabs.architect.mixin;

import java.util.List;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** The template's palettes, so a placement can be written over ticks exactly as {@code placeInWorld} writes it ({@code TemplateWriter}). */
@Mixin(StructureTemplate.class)
public interface StructureTemplateAccessor {
	@Accessor("palettes")
	List<StructureTemplate.Palette> architect$palettes();
}

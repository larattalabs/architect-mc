package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.piston.PistonMovingBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * 6c PT §2: the moving block carries its record (saved as {@code architect_mc:placed} with the block entity, so a chunk saved
 * mid-move keeps it); when it settles, its destination is recorded with it.
 */
@Mixin(PistonMovingBlockEntity.class)
public abstract class PistonMovingBlockEntityMixin extends BlockEntity implements Placed.Carrier {
	@Unique
	private Placed.@Nullable Rec architect$placed;

	protected PistonMovingBlockEntityMixin(BlockEntityType<?> type, BlockPos pos, BlockState state) {
		super(type, pos, state);
	}

	@Override
	public Placed.@Nullable Rec architect$placed() {
		return architect$placed;
	}

	@Override
	public void architect$setPlaced(Placed.@Nullable Rec p) {
		architect$placed = p;
	}

	@Inject(method = "saveAdditional", at = @At("TAIL"))
	private void architect$save(ValueOutput out, CallbackInfo ci) {
		if (architect$placed != null) {
			out.store("architect_mc:placed", CompoundTag.CODEC, architect$placed.toNbt());
		}
	}

	@Inject(method = "loadAdditional", at = @At("TAIL"))
	private void architect$load(ValueInput in, CallbackInfo ci) {
		architect$placed = Placed.Rec.fromNbt(in.read("architect_mc:placed", CompoundTag.CODEC).orElse(null));
	}

	@Inject(method = "tick", at = @At("HEAD"))
	private static void architect$tickBegin(Level level, BlockPos pos, BlockState state, PistonMovingBlockEntity be, CallbackInfo ci) {
		Placed.beginSettle(level, pos, ((Placed.Carrier) be).architect$placed());
	}

	@Inject(method = "tick", at = @At("RETURN"))
	private static void architect$tickEnd(Level level, BlockPos pos, BlockState state, PistonMovingBlockEntity be, CallbackInfo ci) {
		Placed.endSettle();
	}

	@Inject(method = "finalTick", at = @At("HEAD"))
	private void architect$finalBegin(CallbackInfo ci) {
		Placed.beginSettle(this.level, this.worldPosition, architect$placed);
	}

	@Inject(method = "finalTick", at = @At("RETURN"))
	private void architect$finalEnd(CallbackInfo ci) {
		Placed.endSettle();
	}
}

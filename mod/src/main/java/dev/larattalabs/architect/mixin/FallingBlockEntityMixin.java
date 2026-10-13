package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.item.FallingBlockEntity;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 6c PT §2: a falling block (sand, gravel, concrete powder) carries its record and gives it to the cell it lands in. */
@Mixin(FallingBlockEntity.class)
public abstract class FallingBlockEntityMixin extends Entity implements Placed.Carrier {
	@Unique
	private Placed.@Nullable Rec architect$placed;
	@Unique
	private static Placed.@Nullable Rec architect$falling;

	protected FallingBlockEntityMixin(EntityType<?> type, Level level) {
		super(type, level);
	}

	@Override
	public Placed.@Nullable Rec architect$placed() {
		return architect$placed;
	}

	@Override
	public void architect$setPlaced(Placed.@Nullable Rec p) {
		architect$placed = p;
	}

	@Inject(method = "fall", at = @At("HEAD"))
	private static void architect$fallBegin(Level level, BlockPos pos, BlockState state, CallbackInfoReturnable<FallingBlockEntity> cir) {
		architect$falling = Placed.record(level, pos);
	}

	@Inject(method = "fall", at = @At("RETURN"))
	private static void architect$fallEnd(Level level, BlockPos pos, BlockState state, CallbackInfoReturnable<FallingBlockEntity> cir) {
		if (cir.getReturnValue() instanceof Placed.Carrier c) {
			c.architect$setPlaced(architect$falling);
		}
		architect$falling = null;
	}

	@Inject(method = "tick", at = @At("HEAD"))
	private void architect$tickBegin(CallbackInfo ci) {
		Placed.beginLand(this.level(), architect$placed);
	}

	@Inject(method = "tick", at = @At("RETURN"))
	private void architect$tickEnd(CallbackInfo ci) {
		Placed.endLand();
	}

	@Inject(method = "addAdditionalSaveData", at = @At("TAIL"))
	private void architect$save(ValueOutput out, CallbackInfo ci) {
		if (architect$placed != null) {
			out.store("architect_mc:placed", CompoundTag.CODEC, architect$placed.toNbt());
		}
	}

	@Inject(method = "readAdditionalSaveData", at = @At("TAIL"))
	private void architect$load(ValueInput in, CallbackInfo ci) {
		architect$placed = Placed.Rec.fromNbt(in.read("architect_mc:placed", CompoundTag.CODEC).orElse(null));
	}
}

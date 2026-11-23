package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.DevStart;
import dev.larattalabs.architect.site.EntityVisibilityView;
import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.entity.PersistentEntitySectionManager;
import net.minecraft.world.level.entity.Visibility;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice LR2-FIX) A chunk's entity visibility, read by {@code EntityWait}. And (TEST) dev-start.json's {@code entityHide}: for its window
 * after the start, a chunk's entity sections are kept HIDDEN (each change to an accessible visibility is held back, and with it the request
 * to load its stored entities), as a chunk loaded at world start by a restore rolled forward is before its entities load; once the window
 * is over for a chunk its held-back change is made, at the manager's next tick or pending-load pass (vanilla's player spawn waits in
 * {@code waitForEntities}, which runs the pending loads while the server thread blocks). A change to HIDDEN (a chunk leaving) passes and drops a held-back one. Nothing changes without the file.
 */
@Mixin(PersistentEntitySectionManager.class)
public abstract class EntityVisibilityMixin implements EntityVisibilityView {
	@Shadow
	@Final
	private Long2ObjectMap<Visibility> chunkVisibility;

	@Unique
	private final Long2ObjectOpenHashMap<Visibility> architect$deferred = new Long2ObjectOpenHashMap<>();

	@Override
	public boolean architect$accessible(long chunk) {
		Visibility v = chunkVisibility.get(chunk);
		return v != null && v.isAccessible() && !architect$deferred.containsKey(chunk);
	}

	@Inject(method = "updateChunkStatus(Lnet/minecraft/world/level/ChunkPos;Lnet/minecraft/world/level/entity/Visibility;)V", at = @At("HEAD"),
		cancellable = true, require = 1)
	private void architect$hide(ChunkPos pos, Visibility v, CallbackInfo ci) {
		if (!DevStart.entitiesHidden(pos.pack())) {
			architect$deferred.remove(pos.pack());
			return;
		}
		if (v.isAccessible()) {
			architect$deferred.put(pos.pack(), v);
			ci.cancel();
		} else {
			architect$deferred.remove(pos.pack());
		}
	}

	@Inject(method = "tick", at = @At("HEAD"), require = 1)
	private void architect$replay(CallbackInfo ci) {
		architect$replayDue();
	}

	@Inject(method = "processPendingLoads", at = @At("HEAD"), require = 1)
	private void architect$replayOnLoads(CallbackInfo ci) {
		architect$replayDue();
	}

	@Unique
	private void architect$replayDue() {
		if (architect$deferred.isEmpty()) {
			return;
		}
		Long2ObjectOpenHashMap<Visibility> due = new Long2ObjectOpenHashMap<>();
		architect$deferred.long2ObjectEntrySet().forEach(e -> {
			if (!DevStart.entitiesHidden(e.getLongKey())) {
				due.put(e.getLongKey(), e.getValue());
			}
		});
		if (due.isEmpty()) {
			return;
		}
		for (long k : due.keySet().toLongArray()) {
			architect$deferred.remove(k);
		}
		PersistentEntitySectionManager<?> self = (PersistentEntitySectionManager<?>) (Object) this;
		due.long2ObjectEntrySet().forEach(e -> self.updateChunkStatus(ChunkPos.unpack(e.getLongKey()), e.getValue()));
	}
}

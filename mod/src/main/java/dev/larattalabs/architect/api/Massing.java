package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * One version of a massing (docs/CONTRACT.md "Phase 4c contract" and "4c review folded in" item 2): a coarse volume design
 * (masses, roof forms, openings, no detail), installed at {@code <gameDir>/architect/massings/<id>/versions/<v>/} with a copy
 * of the latest version at {@code <gameDir>/architect/massings/<id>/}. Massings never enter the library; show one with
 * {@code ArchitectClientApi.previewComposite} (its id as the layer's {@code blueprintId}) and make the detail design with
 * {@link DesignRequest#fromMassing(String)}. Since 1.3.0.
 *
 * @param versions every installed version of this massing (ascending)
 * @param designId the massing job (design) that made this version
 * @param itemKey the group item it belongs to, when made by a massingFirst group
 * @param ext the request's ext (it round-trips across sidecar restarts)
 * @param group the group it belongs to
 * @param bible the bible pin it was made with
 * @param parts the named masses (each a named part: the detail design keeps the names)
 * @param request the massing request as the sidecar ran it (its {@code model} is the massing model)
 * @param dir the version's folder
 * @param nbt the version's structure template
 * @param previews the version's preview renders
 * @param redirect when this version is a redirect: the version it started from and the notes
 * @param detail the latest detail pass made from this massing (any version)
 */
public record Massing(String id, int version, List<Integer> versions, String designId, String type, Optional<String> name, Optional<String> itemKey,
	JsonObject ext, Optional<String> owner, Optional<String> group, Optional<BiblePin> bible, Map<String, Library.Part> parts, BlockSize size,
	JsonObject request, Cost cost, Path dir, Path nbt, List<Path> previews, Optional<Redirect> redirect, Optional<Detail> detail, long createdAt) {
	public Massing {
		versions = List.copyOf(versions);
		ext = ext == null ? new JsonObject() : ext;
		parts = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(parts));
		previews = List.copyOf(previews);
	}

	/** This version as a reference. */
	public MassingRef ref() {
		return new MassingRef(id, version);
	}

	/** Whether this is the newest installed version. */
	public boolean latest() {
		return versions.isEmpty() || version >= versions.get(versions.size() - 1);
	}

	/** A redirect: the version it was made from and the notes. */
	public record Redirect(int fromVersion, String notes) {
	}

	/** The latest detail pass from this massing: its design, status and (once done) the library entry. */
	public record Detail(String designId, Design.Status status, Optional<String> entryId, long at) {
	}
}

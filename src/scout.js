// Literature search against one fixed host. The agent supplies only search terms and DOIs.
Buddy.Scout = {
	HOST: "https://api.openalex.org",
	FIELDS: "id,doi,title,publication_year,authorships,cited_by_count,open_access,abstract_inverted_index",

	async _get(path, params) {
		const url = `${this.HOST}${path}?${new URLSearchParams(params)}`;
		const xhr = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 20000 });
		return xhr.response;
	},

	_abstract(index, max = 700) {
		if (!index) return "";
		const words = [];
		for (const [word, positions] of Object.entries(index)) {
			for (const p of positions) words[p] = word;
		}
		return words.filter(Boolean).join(" ").slice(0, max);
	},

	/** The item with this DOI in the given library, or in any library when none is given. */
	async findByDOI(doi, libraryID) {
		const libraries = libraryID ? [libraryID] : Buddy.writableLibraries().map((l) => l.libraryID);
		for (const id of libraries) {
			const search = new Zotero.Search();
			search.libraryID = id;
			// "is" is case-sensitive, and DOIs are saved in whatever case the source used.
			search.addCondition("DOI", "contains", doi);
			const match = Zotero.Items.get(await search.search())
				.find((item) => item.getField("DOI").toLowerCase() === doi.toLowerCase());
			if (match) return match;
		}
		return null;
	},

	async _format(works) {
		const out = [];
		for (const w of works) {
			const doi = w.doi ? Zotero.Utilities.cleanDOI(w.doi) : null;
			const owned = doi ? await this.findByDOI(doi) : null;
			out.push({
				title: w.title,
				authors: (w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean),
				year: w.publication_year,
				doi,
				citedBy: w.cited_by_count,
				openAccess: !!w.open_access?.is_oa,
				inLibrary: !!owned,
				itemKey: owned?.key,
				abstract: this._abstract(w.abstract_inverted_index),
			});
		}
		return out;
	},

	async search(query, fromYear, limit = 10) {
		const params = { search: query, "per-page": Math.min(limit, 25), select: this.FIELDS };
		if (fromYear) params.filter = `from_publication_date:${parseInt(fromYear)}-01-01`;
		return this._format((await this._get("/works", params)).results);
	},

	async related(doi, limit = 10) {
		const clean = Zotero.Utilities.cleanDOI(doi);
		if (!clean) throw new Error(`Not a valid DOI: ${doi}`);
		const work = await this._get(`/works/doi:${encodeURIComponent(clean)}`,
			{ select: "id,referenced_works" });
		const id = work.id.split("/").pop();
		const perPage = Math.min(limit, 25);
		const citing = await this._get("/works", {
			filter: `cites:${id}`, sort: "cited_by_count:desc", "per-page": perPage, select: this.FIELDS,
		});
		const refIDs = (work.referenced_works || []).slice(0, 50).map((u) => u.split("/").pop());
		const refs = refIDs.length
			? await this._get("/works", {
				filter: `openalex:${refIDs.join("|")}`, sort: "cited_by_count:desc", "per-page": perPage, select: this.FIELDS,
			})
			: { results: [] };
		return { citedBy: await this._format(citing.results), references: await this._format(refs.results) };
	},

	/**
	 * Saves the paper with this DOI to a destination ("L<libraryID>" or "C<collectionID>") and fetches a free PDF
	 * when one exists. Returns a sentence saying what happened.
	 */
	async addToLibrary(doi, destination) {
		const collection = destination[0] === "C" ? Zotero.Collections.get(parseInt(destination.slice(1))) : null;
		const libraryID = collection ? collection.libraryID : parseInt(destination.slice(1));
		const place = collection ? `“${collection.name}”` : Zotero.Libraries.get(libraryID).name;

		const existing = await this.findByDOI(doi, libraryID);
		if (existing) {
			if (collection && !existing.inCollection(collection.id)) {
				existing.addToCollection(collection.id);
				await existing.saveTx();
			}
			return `Already in this library. It's now in ${place}.`;
		}
		const translate = new Zotero.Translate.Search();
		translate.setIdentifier({ DOI: doi });
		translate.setTranslator(await translate.getTranslators());
		const items = await translate.translate({
			libraryID,
			collections: collection ? [collection.id] : false,
			saveAttachments: false,
		});
		if (!items.length) throw new Error("No metadata found for this DOI.");
		try {
			await Zotero.Attachments.addAvailableFiles(items);
		}
		catch (e) {
			Zotero.debug(`[Research Buddy] PDF lookup failed: ${e}`);
		}
		const pdf = await items[0].getBestAttachment();
		return `Added to ${place}${pdf ? " with PDF." : ". No freely available PDF was found."}`;
	},
};

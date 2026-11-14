/**
 * "Next month's files" demo data (Feature 5, Requirement 6). Bundled inline CSV,
 * so loading it never touches the network.
 *
 * Same file names, headers, and messy patterns as the mismatched demo
 * (inconsistent species spelling, casing and whitespace, exact duplicate rows,
 * a boolean column that must not match), with DIFFERENT rows: new creatures, a
 * new species with new spelling variants, and new duplicates. That lets the
 * recipe story run: stitch month one, save a recipe, reset the lab, load these
 * files, apply the recipe.
 */

/** File A: the containment roster (same headers as the mismatched demo). */
export const NEXT_MONTH_MONSTERS_CSV = `Monster Name,Species,Threat Level,Sedated
Bogsworth,Bog Hag,High,yes
Quill,Cave Howler,Medium,no
Murk,swamp  wraith,Low,no
Hollow,Moth Titan,High,yes
Pinch,bog hag,Low,no
Skrill,Rock Golem,Medium,yes
Nettle,BOG  HAG,High,no
Gloam,Swamp Wraith,Medium,yes
Ember,moth titan,High,no
Rattle,Bone Shambler,Low,yes
Dross,Three-Eyed Ooze,Medium,no
Sorrow,Cave Howler,High,yes
Sorrow,Cave Howler,High,yes
Sorrow,Cave Howler,High,yes
`;

/** File B: field observations of the same creatures. */
export const NEXT_MONTH_EXPERIMENTS_CSV = `monster_name,species,danger_level,hazardous
Bogsworth,Bog Hag,High,true
Quill,cave howler,Medium,false
Murk,Swamp Wraith,Low,true
Hollow,Moth Titan,High,false
Pinch,bog hag,Low,true
Skrill,Rock Golem,Medium,false
Nettle,Bog Hag,High,true
Gloam,swamp wraith,Medium,false
Ember,Moth Titan,High,true
Rattle,Bone Shambler,Low,false
Dross,three-eyed ooze,Medium,true
Sorrow,Cave Howler,High,false
Murk,Swamp Wraith,Low,true
`;

/** The two bundled files, in display order. Names match the mismatched demo. */
export const NEXT_MONTH_DEMO_FILES: readonly { fileName: string; csv: string }[] = [
  { fileName: "monsters.csv", csv: NEXT_MONTH_MONSTERS_CSV },
  { fileName: "experiments.csv", csv: NEXT_MONTH_EXPERIMENTS_CSV },
];

/** Materialize the bundled files as `File` objects for the intake pipeline. */
export async function loadNextMonthFiles(): Promise<File[]> {
  return NEXT_MONTH_DEMO_FILES.map(
    ({ fileName, csv }) => new File([csv], fileName, { type: "text/csv" })
  );
}

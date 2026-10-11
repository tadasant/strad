/**
 * The public downloads the image's data is built from, each PINNED by SHA-256.
 *
 * The digest lives here, in the repo, not on the server that serves the file:
 * a download that changes under the same URL fails the image build by name
 * rather than shipping numbers nobody reviewed. Moving to a newer release is
 * a change to this file — the URL, the digest and the release label together.
 *
 * NOT HERE: USDA Branded. Its CSV release is a 449 MB zip of ~3 GB of CSV and
 * ~450,000 foods, which would add hundreds of MB to an image every bundle
 * component pulls, minutes to every bundle build, and an index this process
 * could not hold in memory beside Chromium. Branded foods are read from the
 * live FoodData Central API instead (remote/fdc.ts), when a key is set.
 */

export interface PinnedSource {
  name: string;
  url: string;
  sha256: string;
  release: string;
}

const FDC = "https://fdc.nal.usda.gov/fdc-datasets";

export const USDA_SOURCES = {
  foundation: {
    name: "USDA FoodData Central — Foundation Foods",
    url: `${FDC}/FoodData_Central_foundation_food_csv_2026-04-30.zip`,
    sha256: "70457ee9d9342f43bda2010318c85f04210c689fdeb9cd2da4c513b0e8dbc655",
    release: "2026-04-30",
  },
  sr_legacy: {
    name: "USDA FoodData Central — SR Legacy",
    url: `${FDC}/FoodData_Central_sr_legacy_food_csv_2018-04.zip`,
    sha256: "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0",
    release: "2018-04",
  },
  fndds: {
    name: "USDA FoodData Central — FNDDS (Survey Foods)",
    url: `${FDC}/FoodData_Central_survey_food_csv_2024-10-31.zip`,
    sha256: "5ccc25ec2777a8982fbb61378a42f415316173eb11e48c9a8ba4cb19f5a4f29c",
    release: "2024-10-31",
  },
} as const satisfies Record<string, PinnedSource>;

/**
 * MenuStat, from NYC Open Data's copy ("DOHMH MenuStat (Historical)",
 * dataset qgc5-ecnb): 2017 and 2018, 96 chains, 65,219 rows. menustat.org
 * itself sits behind a bot challenge a build cannot pass; NYC DOHMH maintains
 * MenuStat and publishes this copy as open data. 2018 is MenuStat's last data
 * year either way.
 */
export const MENUSTAT_SOURCE: PinnedSource = {
  name: "MenuStat (NYC DOHMH, via NYC Open Data qgc5-ecnb)",
  url: "https://data.cityofnewyork.us/api/views/qgc5-ecnb/rows.csv?accessType=DOWNLOAD",
  sha256: "85eb2b4737d3f1bb35f14a3dbc1b3ca460160e95c51b1b6497497809aa84e54a",
  release: "2017–2018",
};

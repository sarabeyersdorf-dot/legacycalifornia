# Photos for 179 Elams Ranch Rd

Drop the property photos into **this folder**. Nothing needs renaming.

**Where they are:** Dropbox → `_LEGACY / _Listings / 179 Elams Ranch Rd listing / corrected /`

**How to add them:** open this folder on github.com, click **Add file → Upload files**,
drag in the photos from that Dropbox folder, then **Commit changes**. Vercel redeploys
in about a minute and the gallery appears on the page.

## How the gallery behaves

`index.html` lists the camera filenames (`20260831_154536.jpg` and so on) and asks the
browser for each one. A file that isn't here yet simply drops out of the grid, and if
none of them are here the whole gallery section stays hidden — so the page looks
finished whether the photos are up or not. Upload order doesn't matter; the grid always
runs in time order, which is the order the shoot walked the property.

## Two notes

- **`collov-ai_20260901135335_nygk2z.jpg` is deliberately not in the list.** It is an
  AI-generated / virtually staged image. If it goes on the page it needs a visible
  "virtually staged" label to stay on the right side of MLS and advertising rules — say
  the word and that label gets added.
- The originals are 2–6 MB each. They will work as-is (the page loads them lazily), but
  smaller copies would make the page noticeably faster on a phone.

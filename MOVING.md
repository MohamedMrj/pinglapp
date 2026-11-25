# Moving Pinglapp to pinglapp.com

A browser keeps each site's data under its exact address. Everyone's reminders and notes are stored under
`mohamedmrj.github.io`, so the old address must hand them over before people switch. This version of `index.html`
does that by itself:

- **At the old address** a banner says Pinglapp has moved, with a **Move my data** button. It opens pinglapp.com and
  sends reminders, notes, pictures, boards and settings there. Nothing is deleted at the old address, and the person
  can move again later (newest wins, so nothing is duplicated).
- **At pinglapp.com** the data is accepted only from the old address, only from the window that opened it, and merged
  in. If the person kept a save file, they're asked to choose it again.

## Go-live order

1. **DNS.** Verify `pinglapp.com` on GitHub and add the DNS records (A, AAAA and `www` CNAME; see GitHub's "Managing a
   custom domain for your GitHub Pages site").
2. **New repo for pinglapp.com.** Create a new repo (e.g. `pinglapp`) with these same files and turn on GitHub Pages.
   Settings → Pages → Custom domain `pinglapp.com`, then "Enforce HTTPS". Check that https://pinglapp.com opens Pinglapp.
3. **Only then** merge this branch into `main` of the old `ping` repo. The old address now shows the move banner.
   (If pinglapp.com isn't live yet, the button only says "pinglapp.com didn't answer"; nothing breaks.)
4. **Keep the old site running** for several months. Never set a custom domain on the old repo: GitHub would redirect
   the old address and the banner would never be seen.
5. From then on, new versions go to the new repo. The old repo only needs to keep this move version.

Daily automatic copies (Settings → Your data) stay at the old address; they aren't moved.

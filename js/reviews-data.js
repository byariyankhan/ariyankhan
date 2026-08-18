/* Single source of truth for curated (hand-picked, real) client reviews.
   Loaded before js/review-card.js on every page that shows a review card —
   the 4 main service pages (each keyed to its own niche) and index.html
   (which combines all 4 and shuffles them). Edit review text here only;
   editing a page's inline markup instead would let it drift out of sync
   with that page's own JSON-LD Review/AggregateRating block, so update
   both together when a review changes. */
window.CURATED_REVIEWS = {
  'talking-head': [
    {
      name: 'kammosh',
      rating: 5,
      body: "Ariyan Khan is a top-notch video editor! The storytelling and visual appeal were outstanding — absolutely the best video work I've ever had on this platform. Working with Ariyan was a breeze; polite, deeply understanding, and proactive in communication."
    },
    {
      name: 'shaqo43',
      rating: 5,
      body: "Ariyan Khan is an exceptional video editor! His work is professional and visually appealing, and he was super responsive and proactive in his communication. Highly recommend — he's keen to help and a pleasure to work with!"
    },
    {
      name: 'joaomrb',
      rating: 5,
      body: 'Another fantastic project from Ariyan. Love how dedicated and talented he is, always making sure the quality is the priority. My only choice for video editing — thank you very much and will be back soon!'
    }
  ],
  documentary: [
    {
      name: 'Daniel Brooks',
      rating: 5,
      body: 'Ariyan did an excellent job with our documentary. The pacing, visuals, and overall storytelling felt natural and polished. He understood the tone we wanted and delivered exactly what we had in mind.'
    },
    {
      name: 'Michael Carter',
      rating: 5,
      body: "Really impressed with Ariyan's editing. He knew exactly where to use B-roll, maps, and motion graphics without making the video feel overloaded. The final documentary was professional and engaging from start to finish."
    },
    {
      name: 'Sophie Bennett',
      rating: 5,
      body: 'Working with Ariyan was a very smooth experience. He turned our script and raw footage into a clear, well-paced documentary with great attention to detail. Communication was easy, and I was very happy with the final result.'
    },
    {
      name: 'Dr. Emily Carter — Physician',
      rating: 5,
      body: 'Ariyan edited a documentary project for me and I was really happy with how it came together. There was a lot of information to work with but the final video never felt confusing or too slow. The visuals and pacing were handled really well.'
    },
    {
      name: 'James Miller — Engineer',
      rating: 5,
      body: 'I sent Ariyan the script, voiceover + a bunch of footage and he understood the direction pretty quickly. The edit felt clean and the b-roll actually helped explain the story instead of just being there. Had a few small revisions and he got them done fast.'
    },
    {
      name: 'Sarah Thompson — Content Producer',
      rating: 5,
      body: "Really enjoyed working with Ariyan on this one. The documentary needed maps, archive footage and a lot of visual storytelling and everything flowed nicely in the final edit. Didn't feel over edited either which I really liked."
    }
  ],
  'short-form': [
    {
      name: 'Jake Miller',
      rating: 5,
      body: 'Ariyan edited a bunch of shorts for us and honestly they came out really good. Fast cuts, captions were clean, and he knew where to add b-roll without making it feel like too much. Would definitely work with him again.'
    },
    {
      name: 'Emma Collins',
      rating: 5,
      body: 'Super easy to work with. I sent over the raw clips and a rough idea, and he turned them into short videos that actually felt engaging. Had a few changes here and there, but he handled them quickly.'
    },
    {
      name: 'Ryan Cooper',
      rating: 5,
      body: 'Really liked the edits. The pacing was on point, and the first few seconds had a much stronger hook than what we had before. Communication was good too — no overcomplicated stuff, just solid work.'
    },
    {
      name: 'Jessica Davis — Marketing Manager',
      rating: 5,
      body: "Sent Ariyan a few raw clips for shorts and didn't give him a ton of direction lol. He still got the pacing, captions and overall style right. The finished videos felt much more engaging than the original footage."
    },
    {
      name: 'Michael Anderson — Software Engineer',
      rating: 5,
      body: 'Really easy process from start to finish. I shared the footage + a couple examples and Ariyan pretty much took it from there. Clean captions, good cuts and no unnecessary effects everywhere.'
    },
    {
      name: 'Rachel Wilson — Entrepreneur',
      rating: 5,
      body: "I've worked with Ariyan on several short videos now and the quality has been really consistent. He knows how to make the first few seconds stronger and keep things moving without making the edit feel chaotic. Def happy with the work."
    }
  ],
  'map-animation': [
    {
      name: 'Kevin Walsh',
      rating: 5,
      body: 'Needed some map animations for a history video and Ariyan did a great job. I mostly just sent the script + locations and he figured out the rest. The zooms, routes and highlights all looked clean and matched the narration really well.'
    },
    {
      name: 'Marcus Reed',
      rating: 5,
      body: 'Really happy with the maps. I had a pretty rough idea of what I wanted but Ariyan understood it quickly and made it look way better than I expected lol. Revisions were quick too, def would work with him again.'
    },
    {
      name: 'Olivia Grant',
      rating: 5,
      body: "Used Ariyan for a documentary that needed quite a few animated maps. Everything was easy to follow and didnt feel overly flashy which I liked. Good communication and the final result fit the video perfectly."
    },
    {
      name: 'David Robinson — Pilot',
      rating: 5,
      body: 'Needed some animated maps for a travel/history video and Ariyan did a great job with them. I mostly gave him the locations and a rough idea of the route. The zooms, lines and highlights came out clean and were really easy to follow.'
    },
    {
      name: 'Dr. Amanda Lewis — Researcher',
      rating: 5,
      body: 'Ariyan helped with several map sequences for a documentary project. Some of the locations were a little complicated to explain but the animations made everything much clearer. Really liked that the maps looked professional without being too flashy.'
    },
    {
      name: 'Christopher Brown — Civil Engineer',
      rating: 5,
      body: 'Had a pretty basic idea for the maps and Ariyan turned it into something much better than I expected tbh. The routes and country highlights matched the narration really well and revisions were quick too. Would definitely work with him again.'
    }
  ]
};

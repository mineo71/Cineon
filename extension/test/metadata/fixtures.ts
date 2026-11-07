// Canned responses shaped like IMDb's suggestion endpoint and Cinemeta, as in MetadataClientTests.cs.

export const DUNE_SEARCH = `
{"d":[
  {"i":{"height":3000,"imageUrl":"https://m.media-amazon.com/images/M/MV5BNTc0YmQxMjEt@._V1_.jpg","width":2025},
   "id":"tt15239678","l":"Dune: Part Two","q":"feature","qid":"movie","rank":46,"s":"Timothée Chalamet, Zendaya","y":2024},
  {"i":{"height":2048,"imageUrl":"https://m.media-amazon.com/images/M/MV5BMDQ0NjgyN2Yt@._V1_.jpg","width":1382},
   "id":"tt1160419","l":"Dune","q":"feature","qid":"movie","rank":180,"s":"Timothée Chalamet, Rebecca Ferguson","y":2021},
  {"id":"tt10466872","l":"Dune: Prophecy","q":"TV series","qid":"tvSeries","rank":500,"s":"Emily Watson, Olivia Williams","y":2024,"yr":"2024-"},
  {"i":{"imageUrl":"https://m.media-amazon.com/images/M/nm.jpg"},"id":"nm3154303","l":"Timothée Chalamet","rank":120,"s":"Actor, Dune"},
  {"id":"tt31613341","l":"Dune: Awakening","q":"video game","qid":"videoGame","y":2025}
],"q":"dune","v":1}`;

export const SEVERANCE_META = `
{"meta":{"id":"tt11280740","imdb_id":"tt11280740","type":"series","name":"Severance",
  "description":"Mark leads a team of office workers whose memories have been surgically divided.",
  "genres":["Drama","Mystery","Sci-Fi"],"runtime":"55 min",
  "poster":"https://images.metahub.space/poster/medium/tt11280740/img",
  "background":"https://images.metahub.space/background/medium/tt11280740/img","releaseInfo":"2022–",
  "videos":[
    {"id":"tt11280740:2:1","name":"Hello, Ms. Cobel","season":2,"number":1,"episode":1,
     "thumbnail":"https://episodes.metahub.space/tt11280740/2/1/w780.jpg","released":"2025-01-17T05:00:00.000Z"},
    {"id":"tt11280740:1:2","name":"Half Loop","season":1,"number":2,"episode":2,"overview":"Mark gets a promotion.",
     "released":"2022-02-18T05:00:00.000Z"},
    {"id":"tt11280740:1:1","name":"Good News About Hell","season":1,"number":1,"description":"Helly wakes up.",
     "released":"2022-02-18T05:00:00.000Z"},
    {"id":"tt11280740:0:1","name":"Behind the scenes","season":0,"episode":1,"released":"2022-03-01T05:00:00.000Z"},
    {"id":"tt11280740:2:2","name":"Goodbye, Mrs. Selvig","season":2,"episode":2,"released":"2025-01-24T05:00:00Z"}
  ]}}`;

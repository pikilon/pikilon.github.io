---
title: Rem + em, a love story
slug: rem-em-love-story
kind: post
date: 2017-06-28
status: published
category: code
tags: [html, css, bem]
summary: With the new times using javascript for everything on the frontend (React.js, Angular.js) CSS is targeting more and more modular coding. This is why if you are progressing in CSS you should learn B…
featured: wp-content/uploads/2017/06/REM.jpg
---

_Not this REM but…_

With the new times using javascript for everything on the frontend (React.js, Angular.js) CSS is targeting more and more modular coding.

This is why if you are progressing in CSS you should learn [BEM](http://getbem.com/) naming conventions.

A common problem I found is the designer use REM units for everything (or even worst PX) because they fear if you use relative units it will be affected by the context, and they want the css rules to be as standalaone as they could. There is a mayor problem with this approach because if you create different sizes of the same component, or you want to change the layout you have to rewrite all the sized attributes. This means more code, more complexity, hard readability…

The solution is to use REM units in the parent and use EM in everychildren, so when you make only a big mediaquery in the body and it will adapt itself all the way down in the body.

Check out this example code I made in codepen.

<figure class="embed embed--codepen"><iframe src="https://codepen.io/pikilon/pen/KqXbWr?default-tab=css%2Cresult" title="CSS relative units in component layouting" loading="lazy" height="265" allowfullscreen></iframe><figcaption>CSS relative units in component layouting — <a href="https://codepen.io/pikilon/pen/KqXbWr">ver en CodePen</a></figcaption></figure>

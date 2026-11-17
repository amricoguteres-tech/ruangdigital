# RuangDigital design direction

## Identity

RuangDigital is an Indonesian digital studio. The interface should feel like a working studio: candid, precise, and comfortable explaining technical work in plain language. It should not imply a customer base, finished case studies, service guarantees, or performance numbers that the business has not verified.

Reading this as: an Indonesian digital studio homepage and account/admin interface for prospective customers and existing users, with a warm Nordic studio visual language, dial ENERGY 3 / RHYTHM 3 / MOTION 3.

## Visual system

- Deep Nordic slate `#1B2D3B` anchors the brand, hero, and operational surfaces.
- Warm stone `#F2EFE8` is the main surface; soft white is reserved for focused work areas.
- Muted steel blue `#355F6B` marks actions and links. Pale steel teal `#90AAA5` is a restrained supporting accent.
- Use Manrope for display and DM Sans for reading. DM Mono is limited to short labels, dates, and technical metadata.
- The warm stone surface keeps long-form content readable; deep slate gives the digital studio a clear anchor, and steel teal marks key actions without turning the whole page into an accent.
- Use the existing intro video as a full-bleed animated hero background, with the offer layered above it and a dark scrim that keeps the headline readable.
- A low-contrast steel-teal wash over the video adds depth without obscuring its movement; it fades in once and does not pulse.
- Glass buttons are an explicit user-approved exception to the usual glassmorphism restraint (R-37); restrained blur and translucent fills give every action a shared tactile surface, while each button's brand color and high-contrast label preserve its hierarchy.
- Use GSAP and ScrollTrigger for short, one-time reveals as sections enter, Lenis for smooth page navigation, and a clear Three.js sculpture in the hero's open right side. Three beveled bars, a closed route, orbit paths, and moving nodes connect the studio's product and infrastructure work; scrolling assembles the bars, turns the sculpture through a restrained path, and carries the nodes around its route.
- The account dialog and admin summary enter once when opened or loaded, giving those separate working surfaces a clear arrival without animating live data as decoration.
- Keep motion short and tied to navigation, hierarchy, or feedback. Do not animate cards continuously, add fake urgency, or stack decorative effects.
- Use rounded surfaces for actual grouped decisions, such as service details, package comparisons, and account forms. Keep section rhythm varied and avoid decorative grids or floating orbs.

## Composition and voice

- The homepage reads like a studio introduction: one clear offer, services, a useful domain check, real package terms, examples labeled as concepts, working process, maintenance, FAQ, and contact.
- Group product work separately from infrastructure because visitors compare those needs differently. Use package panels only to compare the real hosting and VPS terms.
- Keep account forms and the admin dashboard task-focused. Surface errors, loading, empty, and success states in place.
- Write Indonesian copy directly and plainly. Do not invent clients, testimonials, results, urgency, or social proof.
- Responsive layouts reflow for their content. Test narrow phones, tablet widths, and desktop; prevent horizontal page overflow and preserve usable tap targets.
- Motion is brief and functional. Respect reduced-motion preferences and do not animate content into a hidden state.

## Purpose of recurring elements

- The full-bleed video gives the studio introduction a real visual source; the dark scrim keeps the offer readable while letting the footage animate behind it.
- The fixed header and mobile navigation keep the long service page navigable.
- The header gains a restrained translucent surface only after scroll so navigation remains visually separate from moving content.
- Every button uses a light glass treatment; a slow, eased press response makes the click feel registered without slowing the action itself.
- Service and pricing panels lift only on hover or keyboard focus because they contain consultation or order actions; non-interactive concept artwork stays still.
- Text-action underlines draw in on hover or keyboard focus to make links easier to identify without adding decorative arrows.
- The muted hero video loops while the page is visible, pauses when the tab is hidden or reduced motion is requested, and resumes when the page becomes visible again. GSAP reveals content once as each section enters the viewport; Three.js moves in response to scrolling, keeps its path within the screen at each breakpoint, and respects reduced-motion preferences.
- The thin scroll-progress marker helps visitors track position on a long service page without taking space from the content.
- Monospaced labels distinguish operational metadata from customer-facing copy.
- Steel blue identifies actions; pale teal is reserved for a few supporting highlights.
- The admin page prioritizes the consultation and order tables because those are its working tasks.
- Pricing is grouped by service terms so package amounts remain easy to compare without implying a popularity ranking.
- CSS-built work samples are labeled as concepts because verified client case studies are not supplied.
- The account panel lists the actual account tasks and omits invented customer avatars or results.

/** Short motivational quotes shown on the focus-session ending screen. */
export interface Quote {
  text: string
  author: string
}

export const QUOTES: Quote[] = [
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'Little by little, one travels far.', author: 'J.R.R. Tolkien' },
  { text: 'It always seems impossible until it’s done.', author: 'Nelson Mandela' },
  { text: 'Done is better than perfect.', author: 'Sheryl Sandberg' },
  { text: 'You don’t have to be great to start, but you have to start to be great.', author: 'Zig Ziglar' },
  { text: 'Focus is a matter of deciding what things you’re not going to do.', author: 'John Carmack' },
  { text: 'Small daily improvements over time lead to stunning results.', author: 'Robin Sharma' },
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Augusta F. Kantra' },
  { text: 'What we do today is what matters most.', author: 'Buddha' },
  { text: 'Energy and persistence conquer all things.', author: 'Benjamin Franklin' },
  { text: 'The future depends on what you do today.', author: 'Mahatma Gandhi' },
  { text: 'Slow is smooth, and smooth is fast.', author: 'Navy SEALs' },
  { text: 'A river cuts through rock not because of its power, but its persistence.', author: 'Jim Watkins' },
  { text: 'Great things are done by a series of small things brought together.', author: 'Vincent van Gogh' },
  { text: 'Start where you are. Use what you have. Do what you can.', author: 'Arthur Ashe' }
]

export function randomQuote(): Quote {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)]
}

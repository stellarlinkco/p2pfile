export const currentTime = {
  now: () => Date.now(),
};

export function resetEdgeNowForTests() {
  currentTime.now = () => Date.now();
}

export function setEdgeNowForTests(nextNow: () => number) {
  currentTime.now = nextNow;
}

// The hello site's visitors who have not signed in may say hello; a signed-in visitor (the
// members site's) may not, as no permit names the visitors group.
permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:hello", resource);

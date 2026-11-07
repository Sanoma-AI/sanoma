// A visitor signed in through Better Auth may start hello, and nothing else.
permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:hello", resource);
